// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    Gio,
    GLib,
    GObject,
    Meta,
    Shell,
    St,
} from './dependencies/gi.js';

import {
    AppFavorites,
    Dash,
    DND,
    Main,
} from './dependencies/shell/ui.js';

import {
    Config,
    Util,
} from './dependencies/shell/misc.js';

import {
    AppIcons,
    Docking,
    Theming,
    Utils,
} from './imports.js';

// module "Dash" did not export DASH_ANIMATION_TIME in old versions
// so we just define it like it is defined in Dash;
// taken from https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/dash.js
const DASH_ANIMATION_TIME = Dash.DASH_ANIMATION_TIME ?? 200;
const DASH_VISIBILITY_TIMEOUT = 3;
// Icons that magnify push their neighbours sideways (macOS-style spread).
// The +-2 ring only scales by a hair yet is still pushed by the +-1 ring:
// gating each icon's spread by how much *it* magnifies keeps the +-2 ring
// anchored in the dock while the +-1 ring keeps its full spread.
const SPREAD_MAGNIFICATION_GATE = 0.06;

// PulsarOS / Golden Gate: hover magnification tuned to the macOS dock,
// mirrored from simple-taskbar by sultech (GPL-2.0-or-later):
//   zoom      2.0  peak scale, rounded icons double in size
//   extent    7    magnification radius = iconSize * extent / 2
//   convexity 1    pure cosine bell falloff
//   settle    80   smoothing settle time in ms -> tau = settle / 2
const PULSAR_MAGNIFY_ZOOM = 2.0;
const PULSAR_MAGNIFY_EXTENT = 7;
const PULSAR_MAGNIFY_CONVEXITY = 1;
const PULSAR_MAGNIFY_SETTLE_MS = 80;
const PULSAR_MAGNIFY_TIME_CONSTANTS = 2;
const PULSAR_MAGNIFY_EPSILON = 0.01;
const PULSAR_MAGNIFY_PANEL_PAD = 10;
// PULSAR-GG5B -- safety cap for a launch freeze whose bounce never
// settles; the bounce end or the app opening normally releases first.
const PULSAR_MAGNIFY_LAUNCH_PIN_MS = 10000;
const PULSAR_MAGNIFY_MENU_RELAX_MS = 150;
// PULSAR-GG4F -- once magnifying, the pointer has to leave the hover
// region by a real step before the row relaxes.
const PULSAR_MAGNIFY_LEAVE_MARGIN = 32;
// PULSAR-GG6A -- perpendicular (to the dock axis) hover margins, measured
// from the icons themselves: entering needs a touch of the icons, leaving
// a hair of a step, so a pointer resting on the boundary cannot flicker.
const PULSAR_MAGNIFY_PERP_ENTER = 2;
const PULSAR_MAGNIFY_PERP_LEAVE = 4;
// PULSAR-GG5B -- frames without a bounce before an icon click that never
// jumped (focus/minimise) gives the freeze back.
const PULSAR_MAGNIFY_LAUNCH_GRACE_FRAMES = 30;
// PULSAR-GG4A -- per-frame easing of the published panel overflow.
const PULSAR_MAGNIFY_OVERFLOW_EASE = 0.35;

const Labels = Object.freeze({
    SHOW_MOUNTS: Symbol('show-mounts'),
    FIRST_LAST_CHILD_WORKAROUND: Symbol('first-last-child-workaround'),
});

/**
 * Extend DashItemContainer
 *
 * - set label position based on dash orientation
 *
 */
const DockDashItemContainer = GObject.registerClass(
class DockDashItemContainer extends Dash.DashItemContainer {
    _init(position) {
        super._init({
            clip_to_allocation: false,
        });

        this.label?.add_style_class_name(Theming.PositionStyleClass[position]);
        if (Docking.DockManager.settings.customThemeShrink)
            this.label?.add_style_class_name('shrink');
    }

    showLabel() {
        return AppIcons.itemShowLabel.call(this);
    }

    // we override the method show taken from:
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/dash.js
    // in order to apply a little modification at the end of the animation
    // which makes sure that the icon background is not blurry
    show(animate) {
        if (this.child == null)
            return;

        this.ease({
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: animate ? DASH_ANIMATION_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // when the animation is ended, we simulate
                // a hover to gain back focus and unblur the
                // background
                this.set_hover(true);
            },
        });
    }
});

const DockDashIconsVerticalLayout = GObject.registerClass(
    class DockDashIconsVerticalLayout extends Clutter.BoxLayout {
        _init() {
            super._init({
                orientation: Clutter.Orientation.VERTICAL,
            });
        }

        vfunc_get_preferred_height(container, forWidth) {
            const [natHeight] = super.vfunc_get_preferred_height(container, forWidth);
            return [natHeight, 0];
        }
    });

const DockMinimizedWindowItem = GObject.registerClass(
class DockMinimizedWindowItem extends St.Button {
    _init(metaWindow, iconSize, isHorizontal) {
        super._init({
            style_class: 'app-well-app minimized-window-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this.metaWindow = metaWindow;
        this.iconSize = iconSize;
        this._isHorizontal = isHorizontal;

        const bin = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: iconSize,
            height: iconSize,
        });

        this._previewBin = bin;
        this.set_child(bin);

        this._updateThumbnail();

        // Refresh thumbnail after layout completes in case window texture is ready later
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.mapped)
                this._updateThumbnail();
            return GLib.SOURCE_REMOVE;
        });

        this.connect('clicked', () => {
            if (this.metaWindow) {
                Main.activateWindow(this.metaWindow);
            }
        });

        this._destroyId = this.metaWindow.connect('unmanaged', () => {
            this.destroy();
        });
    }

    _updateThumbnail() {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(this.metaWindow);

        const mutterWindow = this.metaWindow?.get_compositor_private();
        if (mutterWindow && mutterWindow.get_texture()) {
            const clone = new Clutter.Clone({
                source: mutterWindow,
                reactive: false,
            });
            const [w, h] = mutterWindow.get_size();
            if (w > 0 && h > 0) {
                const padding = 6;
                const availableSize = Math.max(16, this.iconSize - padding);
                const scale = Math.min(availableSize / w, availableSize / h);
                const cloneWidth = Math.max(16, Math.round(w * scale));
                const cloneHeight = Math.max(16, Math.round(h * scale));
                clone.set_size(cloneWidth, cloneHeight);

                const container = new St.Widget({
                    layout_manager: new Clutter.BinLayout(),
                    width: this.iconSize,
                    height: this.iconSize,
                });
                container.add_child(clone);

                // Small mini app icon emblem in the corner like macOS
                if (app) {
                    const emblemSize = Math.round(this.iconSize * 0.35);
                    const miniIcon = app.create_icon_texture(emblemSize);
                    miniIcon.set({
                        x_align: Clutter.ActorAlign.END,
                        y_align: Clutter.ActorAlign.END,
                    });
                    container.add_child(miniIcon);
                }

                this._previewBin.set_child(container);
                return;
            }
        }

        const icon = app ? app.create_icon_texture(this.iconSize) : new St.Icon({
            icon_name: 'window-new-symbolic',
            icon_size: this.iconSize,
        });
        this._previewBin.set_child(icon);
    }

    destroy() {
        if (this._destroyId && this.metaWindow) {
            try {
                this.metaWindow.disconnect(this._destroyId);
            } catch {}
            this._destroyId = 0;
        }
        super.destroy();
    }
});


const baseIconSizes = [16, 22, 24, 32, 48, 64, 96, 128];

/**
 * This class is a fork of the upstream dash class (ui.dash.js)
 *
 * Summary of changes:
 * - disconnect global signals adding a destroy method;
 * - play animations even when not in overview mode
 * - set a maximum icon size
 * - show running and/or favorite applications
 * - hide showApps label when the custom menu is shown.
 * - add scrollview
 *   ensure actor is visible on keyfocus inseid the scrollview
 * - add 128px icon size, might be useful for hidpi display
 * - sync minimization application target position.
 * - keep running apps ordered.
 */
export const DockDash = GObject.registerClass({
    Properties: {
        'requires-visibility': GObject.ParamSpec.boolean(
            'requires-visibility', 'requires-visibility', 'requires-visibility',
            GObject.ParamFlags.READWRITE,
            false),
        'max-width': GObject.ParamSpec.int(
            'max-width', 'max-width', 'max-width',
            GObject.ParamFlags.READWRITE,
            -1, GLib.MAXINT32, -1),
        'max-height': GObject.ParamSpec.int(
            'max-height', 'max-height', 'max-height',
            GObject.ParamFlags.READWRITE,
            -1, GLib.MAXINT32, -1),
    },
    Signals: {
        'menu-opened': {},
        'menu-closed': {},
        'icon-size-changed': {},
    },
}, class DockDash extends St.Widget {
    _init(monitorIndex) {
        // Initialize icon variables and size
        super._init({
            name: 'dash',
            clip_to_allocation: false,
            layout_manager: new Clutter.BinLayout(),
        });

        this._maxWidth = -1;
        this._maxHeight = -1;
        this.iconSize = Docking.DockManager.settings.dashMaxIconSize;
        this._availableIconSizes = baseIconSizes;
        this._shownInitially = false;
        this._initializeIconSize(this.iconSize);
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);

        this._separator = null;

        this._monitorIndex = monitorIndex;
        this._position = Utils.getPosition();
        this._isHorizontal = (this._position === St.Side.TOP) ||
                               (this._position === St.Side.BOTTOM);

        this._dragPlaceholder = null;
        this._dragPlaceholderPos = -1;
        this._animatingPlaceholdersCount = 0;
        this._showLabelTimeoutId = 0;
        this._resetHoverTimeoutId = 0;
        this._labelShowing = false;

        this._dashContainer = new St.BoxLayout({
            name: 'dashtodockDashContainer',
            clip_to_allocation: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            orientation: !this._isHorizontal ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            y_expand: false,
            x_expand: false,
        });

        this._scrollView = new St.ScrollView({
            name: 'dashtodockDashScrollview',
            clip_to_allocation: false,
            hscrollbar_policy: this._isHorizontal ? St.PolicyType.EXTERNAL : St.PolicyType.NEVER,
            vscrollbar_policy: this._isHorizontal ?  St.PolicyType.NEVER : St.PolicyType.EXTERNAL,
            x_expand: false,
            y_expand: false,
            enable_mouse_scrolling: false,
        });

        this._scrollView.connect('scroll-event', this._onScrollEvent.bind(this));

        // St.ScrollView may re-enable clipping when its style changes; keep it
        // off so magnified icons are never cut by the scroll viewport
        this._scrollView.connect('style-changed', () => {
            if (this._scrollView.clip_to_allocation)
                this._scrollView.clip_to_allocation = false;
        });

        this._boxContainer = new St.BoxLayout({
            name: 'dashtodockBoxContainer',
            clip_to_allocation: false,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            orientation: !this._isHorizontal ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            reactive: true,
        });
        this._boxContainer.add_style_class_name(Theming.PositionStyleClass[this._position]);

        this._boxContainer.connect('motion-event', (_actor, event) => {
            this._onDockMotionEvent(event);
            return Clutter.EVENT_PROPAGATE;
        });
        this._boxContainer.connect('leave-event', () => {
            this._pulsarPointerInDock = false;
            this._pulsarPointerX = null;
            this._pulsarPointerY = null;

            // Golden Gate: never snap back. Leaving the dock hands over to
            // the magnification pass, which keeps the icons alive while the
            // pointer rests on them and otherwise settles everything to rest
            // with the same exponential easing as the hover.
            if (!this._pulsarMagRetreating)
                this._pulsarMagnifyStart();
            return Clutter.EVENT_PROPAGATE;
        });

        // Keep magnification in sync with the dock sliding away/back
        // (autohide/intellihide): without this, floating clones stay at
        // their last pose while the dock (and its real icons) move away,
        // leaving a static duplicate on screen.
        const dockManager = Docking.DockManager.getDefault();
        this._pulsarDockHideId = dockManager.connect('hiding', () => {
            this._pulsarRetreatMagnification();
        });
        this._pulsarDockShowId = dockManager.connect('showing', () => {
            this._pulsarReapplyMagnification();
        });
        this.connect('destroy', () => {
            try {
                dockManager.disconnect(this._pulsarDockHideId);
                dockManager.disconnect(this._pulsarDockShowId);
            } catch {}
        });

        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        this._box = new St.BoxLayout({
            orientation: !this._isHorizontal ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            clip_to_allocation: false,
            ...!this._isHorizontal ? {layout_manager: new DockDashIconsVerticalLayout()} : {},
            x_align: rtl ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
            y_align: this._isHorizontal ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            y_expand: false,
            x_expand: false,
        });
        this._box._delegate = this;
        this._boxContainer.add_child(this._box);
        Utils.addActor(this._scrollView, this._boxContainer);
        this._dashContainer.add_child(this._scrollView);

        this._showAppsIcon = new AppIcons.DockShowAppsIcon(this._position);
        this._showAppsIcon.show(false);
        this._showAppsIcon.icon.setIconSize(this.iconSize);
        this._showAppsIcon.x_expand = false;
        this._showAppsIcon.y_expand = false;
        this.showAppsButton.connect('notify::hover', a => {
            if (this._showAppsIcon.get_parent() === this._boxContainer)
                this._ensureItemVisibility(a);
        });
        if (!this._isHorizontal)
            this._showAppsIcon.y_align = Clutter.ActorAlign.START;
        this._hookUpLabel(this._showAppsIcon);
        this._showAppsIcon.connect('menu-state-changed', (_icon, opened) => {
            this._itemMenuStateChanged(this._showAppsIcon, opened);
        });
        this.updateShowAppsButton();

        this._background = new St.Widget({
            style_class: 'dash-background',
            y_expand: this._isHorizontal,
            x_expand: !this._isHorizontal,
        });

        const sizerBox = new Clutter.Actor();
        sizerBox.add_constraint(new Clutter.BindConstraint({
            source: this._isHorizontal ? this._showAppsIcon.icon : this._dashContainer,
            coordinate: Clutter.BindCoordinate.HEIGHT,
        }));
        sizerBox.add_constraint(new Clutter.BindConstraint({
            source: this._isHorizontal ? this._dashContainer : this._showAppsIcon.icon,
            coordinate: Clutter.BindCoordinate.WIDTH,
        }));
        this._background.add_child(sizerBox);

        this.add_child(this._background);
        this.add_child(this._dashContainer);

        this._queueRedisplay();

        this._shellSettings = new Gio.Settings({
            schema_id: 'org.gnome.shell',
        });

        this._appSystem = Shell.AppSystem.get_default();

        this.iconAnimator = new Docking.IconAnimator(this);

        this._signalsHandler.add([
            this._appSystem,
            'installed-changed',
            () => {
                AppFavorites.getAppFavorites().reload();
                this._queueRedisplay();
            },
        ], [
            this._shellSettings,
            'changed::favorite-apps',
            () => {
                AppFavorites.getAppFavorites().reload();
                this._queueRedisplay();
            },
        ], [
            AppFavorites.getAppFavorites(),
            'changed',
            this._queueRedisplay.bind(this),
        ], [
            this._appSystem,
            'app-state-changed',
            this._queueRedisplay.bind(this),
        ], [
            global.display,
            'window-created',
            (_display, window) => {
                window.connectObject('notify::minimized', () => this._queueRedisplay(), this);
                this._queueRedisplay();
            },
        ], [
            global.display,
            'restacked',
            () => this._queueRedisplay(),
        ], [
            global.window_manager,
            'minimize',
            () => this._queueRedisplay(),
        ], [
            global.window_manager,
            'unminimize',
            () => this._queueRedisplay(),
        ], [
            global.workspace_manager,
            'active-workspace-changed',
            () => this._queueRedisplay(),
        ], [
            Main.overview,
            'item-drag-begin',
            this._onItemDragBegin.bind(this),
        ], [
            Main.overview,
            'item-drag-end',
            this._onItemDragEnd.bind(this),
        ], [
            Main.overview,
            'item-drag-cancelled',
            this._onItemDragCancelled.bind(this),
        ], [
            Main.overview,
            'window-drag-begin',
            this._onWindowDragBegin.bind(this),
        ], [
            Main.overview,
            'window-drag-cancelled',
            this._onWindowDragEnd.bind(this),
        ], [
            Main.overview,
            'window-drag-end',
            this._onWindowDragEnd.bind(this),
        ]);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    vfunc_get_preferred_height(forWidth) {
        const [minHeight, natHeight] = super.vfunc_get_preferred_height.call(this, forWidth);
        if (!this._isHorizontal && this._maxHeight !== -1 && natHeight > this._maxHeight)
            return [minHeight, this._maxHeight];
        else
            return [minHeight, natHeight];
    }

    vfunc_get_preferred_width(forHeight) {
        const [minWidth, natWidth] = super.vfunc_get_preferred_width.call(this, forHeight);
        if (this._isHorizontal && this._maxWidth !== -1 && natWidth > this._maxWidth)
            return [minWidth, this._maxWidth];
        else
            return [minWidth, natWidth];
    }

    get _container() {
        return this._dashContainer;
    }

    _onDestroy() {
        this.iconAnimator.destroy();

        if (this._redisplayQueueId) {
            GLib.source_remove(this._redisplayQueueId);
            delete this._redisplayQueueId;
        }

        if (this._requiresVisibilityTimeout) {
            GLib.source_remove(this._requiresVisibilityTimeout);
            delete this._requiresVisibilityTimeout;
        }

        if (this._ensureActorVisibilityTimeoutId) {
            GLib.source_remove(this._ensureActorVisibilityTimeoutId);
            delete this._ensureActorVisibilityTimeoutId;
        }
    }


    _onItemDragBegin(...args) {
        return Dash.Dash.prototype._onItemDragBegin.call(this, ...args);
    }

    _onItemDragCancelled(...args) {
        return Dash.Dash.prototype._onItemDragCancelled.call(this, ...args);
    }

    _onItemDragEnd(...args) {
        return Dash.Dash.prototype._onItemDragEnd.call(this, ...args);
    }

    _endItemDrag(...args) {
        return Dash.Dash.prototype._endItemDrag.call(this, ...args);
    }

    _onItemDragMotion(...args) {
        return Dash.Dash.prototype._onItemDragMotion.call(this, ...args);
    }

    _appIdListToHash(...args) {
        return Dash.Dash.prototype._appIdListToHash.call(this, ...args);
    }

    _queueRedisplay() {
        if (this._redisplayQueueId)
            return;
        this._redisplayQueueId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._redisplayQueueId = 0;
            this._redisplay();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hookUpLabel(...args) {
        return Dash.Dash.prototype._hookUpLabel.call(this, ...args);
    }

    _syncLabel(...args) {
        return Dash.Dash.prototype._syncLabel.call(this, ...args);
    }

    _clearDragPlaceholder(...args) {
        return Dash.Dash.prototype._clearDragPlaceholder.call(this, ...args);
    }

    _clearEmptyDropTarget(...args) {
        return Dash.Dash.prototype._clearEmptyDropTarget.call(this, ...args);
    }

    handleDragOver(source, actor, x, y, time) {
        let ret;
        if (this._isHorizontal) {
            ret = Dash.Dash.prototype.handleDragOver.call(this, source, actor, x, y, time);

            if (ret === DND.DragMotionResult.CONTINUE)
                return ret;
        } else {
            const propertyInjections = new Utils.PropertyInjectionsHandler();
            propertyInjections.add(this._box, 'width', {
                get: () => this._box.get_children().reduce((a, c) => a + c.height, 0),
            });

            if (this._dragPlaceholder) {
                propertyInjections.add(this._dragPlaceholder, 'width', {
                    get: () => this._dragPlaceholder.height,
                });
            }

            ret = Dash.Dash.prototype.handleDragOver.call(this, source, actor, y, x, time);
            propertyInjections.destroy();

            if (ret === DND.DragMotionResult.CONTINUE)
                return ret;

            if (this._dragPlaceholder) {
                this._dragPlaceholder.child.set_width(this.iconSize / 2);
                this._dragPlaceholder.child.set_height(this.iconSize);

                let pos = this._dragPlaceholderPos;
                if (this._isHorizontal &&
                    Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
                    pos = this._box.get_children() - 1 - pos;

                if (pos !== this._dragPlaceholderPos) {
                    this._dragPlaceholderPos = pos;
                    this._box.set_child_at_index(this._dragPlaceholder,
                        this._dragPlaceholderPos);
                }
            }
        }

        if (this._dragPlaceholder) {
            // Ensure the next and previous icon are visible when moving the
            // placeholder (we're assuming there's room for both of them)
            const children = this._box.get_children();
            if (this._dragPlaceholderPos > 0) {
                ensureActorVisibleInScrollView(this._scrollView,
                    children[this._dragPlaceholderPos - 1]);
            }

            if (this._dragPlaceholderPos >= -1 &&
                this._dragPlaceholderPos < children.length - 1) {
                ensureActorVisibleInScrollView(this._scrollView,
                    children[this._dragPlaceholderPos + 1]);
            }
        }

        return ret;
    }

    acceptDrop(...args) {
        return Dash.Dash.prototype.acceptDrop.call(this, ...args);
    }

    _onWindowDragBegin(...args) {
        return Dash.Dash.prototype._onWindowDragBegin.call(this, ...args);
    }

    _onWindowDragEnd(...args) {
        return Dash.Dash.prototype._onWindowDragEnd.call(this, ...args);
    }

    _onScrollEvent(actor, event) {
        // reset timeout to avoid conflicts with the mousehover event
        this._ensureItemVisibility(null);

        let adjustment, delta = 0;

        if (this._isHorizontal) {
            adjustment = this._scrollView.get_hadjustment
                ? this._scrollView.get_hadjustment()
                : this._scrollView.get_hscroll_bar()?.get_adjustment();
        } else {
            adjustment = this._scrollView.get_vadjustment
                ? this._scrollView.get_vadjustment()
                : this._scrollView.get_vscroll_bar()?.get_adjustment();
        }

        if (!adjustment)
            return Clutter.EVENT_PROPAGATE;

        const increment = adjustment.step_increment || 30;
        let dx = 0, dy = 0;

        if (event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH) {
            [dx, dy] = event.get_scroll_delta();
        } else if (event.get_scroll_direction() === Clutter.ScrollDirection.UP) {
            dy = -1;
        } else if (event.get_scroll_direction() === Clutter.ScrollDirection.DOWN) {
            dy = 1;
        }

        if (this._isHorizontal)
            delta = (Math.abs(dx) > Math.abs(dy) ? dx : dy) * increment;
        else
            delta = dy * increment;

        if (delta === 0)
            return Clutter.EVENT_PROPAGATE;

        const value = adjustment.get_value();
        const lower = adjustment.get_lower();
        const upper = adjustment.get_upper() - adjustment.get_page_size();

        const newValue = Math.min(Math.max(value + delta, lower), Math.max(lower, upper));
        adjustment.set_value(newValue);

        return Clutter.EVENT_STOP;
    }

    _ensureItemVisibility(actor) {
        if (actor?.hover) {
            const destroyId =
                actor.connect('destroy', () => this._ensureItemVisibility(null));
            this._ensureActorVisibilityTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 100, () => {
                    actor.disconnect(destroyId);
                    ensureActorVisibleInScrollView(this._scrollView, actor);
                    this._ensureActorVisibilityTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                });
        } else if (this._ensureActorVisibilityTimeoutId) {
            GLib.source_remove(this._ensureActorVisibilityTimeoutId);
            this._ensureActorVisibilityTimeoutId = 0;
        }
    }

    _createAppItem(app) {
        const appIcon = new AppIcons.makeAppIcon(app, this._monitorIndex, this.iconAnimator);

        if (appIcon._draggable) {
            appIcon._draggable.connect('drag-begin', () => {
                appIcon.opacity = 50;
            });
            appIcon._draggable.connect('drag-end', () => {
                appIcon.opacity = 255;
            });
        }

        appIcon.connectObject('menu-state-changed', (_, opened) => {
            this._itemMenuStateChanged(item, opened);
            // PULSAR-GG3D -- the Downloads and Trash lists open *over* the
            // row: the icons go back to rest so the menu is usable.
            this._pulsarMagnifySetMenuOpen(opened);
        }, this);

        const item = new DockDashItemContainer(this._position);
        item.setChild(appIcon);

        appIcon.connectObject('notify::hover', a => {
            // With magnification the lateral spread intentionally pushes
            // icons beyond the scroll viewport; scrolling to reveal them
            // causes a phantom horizontal scrollbar and clipped edges
            if (!Docking.DockManager.settings.dockMagnification)
                this._ensureItemVisibility(a);
        }, this);
        appIcon.connectObject('clicked', actor => {
            if (!Docking.DockManager.settings.dockMagnification) {
                ensureActorVisibleInScrollView(this._scrollView, actor);
            } else {
                // PULSAR-GG3D -- the row stays spread while the app the user
                // just clicked is still opening.
                this._pulsarMagnifyPinLaunch(appIcon);
            }
        }, this);

        appIcon.connectObject('key-focus-in', actor => {
            const [xShift, yShift] = ensureActorVisibleInScrollView(this._scrollView, actor);

            // This signal is triggered also by mouse click. The popup menu is opened at the original
            // coordinates. Thus correct for the shift which is going to be applied to the scrollview.
            if (appIcon._menu) {
                appIcon._menu._boxPointer.xOffset = -xShift;
                appIcon._menu._boxPointer.yOffset = -yShift;
            }
        }, this);

        appIcon.connectObject('notify::focused', () => {
            const {settings} = Docking.DockManager;
            if (appIcon.focused && settings.scrollToFocusedApplication)
                ensureActorVisibleInScrollView(this._scrollView, item);
        }, this);

        appIcon.connectObject('notify::urgent', () => {
            if (appIcon.urgent) {
                ensureActorVisibleInScrollView(this._scrollView, item);
                if (Docking.DockManager.settings.showDockUrgentNotify)
                    this._requireVisibility();
            }
        }, this);

        // Override default AppIcon label_actor, now the
        // accessible_name is set at DashItemContainer.setLabelText
        appIcon.label_actor = null;
        item.setLabelText(app.get_name());

        appIcon.icon.setIconSize(this.iconSize);
        this._hookUpLabel(item, appIcon);

        item.connectObject('notify::position', () => appIcon.updateIconGeometry(), appIcon);
        item.connectObject('notify::size', () => appIcon.updateIconGeometry(), appIcon);

        return item;
    }

    _requireVisibility() {
        this.requiresVisibility = true;

        if (this._requiresVisibilityTimeout)
            GLib.source_remove(this._requiresVisibilityTimeout);

        this._requiresVisibilityTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            DASH_VISIBILITY_TIMEOUT, () => {
                this._requiresVisibilityTimeout = 0;
                this.requiresVisibility = false;
            });
    }

    _onDockMotionEvent(event) {
        const [pointerX, pointerY] = event.get_coords();

        // Remember the pointer pose so the magnification can be re-applied
        // when the dock rebuilds its icon list without any pointer motion.
        this._pulsarPointerInDock = true;
        this._pulsarPointerX = pointerX;
        this._pulsarPointerY = pointerY;

        if (!Docking.DockManager.settings.dockMagnification) {
            this._resetMagnification();
            return;
        }

        // PULSAR-GG3D -- a popup menu owns the dock while it is open: the
        // pointer no longer magnifies the row underneath it.
        if (this._pulsarMagMenuOpen)
            return;

        this._pulsarMagRetreating = false;
        this._pulsarMagActive = true;
        this._pulsarMagnifyStart();
    }

    // --------------------------------------------------------------------
    // Golden Gate hover magnification (algorithm from simple-taskbar).
    //
    // The row of dock items physically spreads around the pointer: every
    // item is translated along the dock axis by the growth of its
    // neighbours and the whole row is offset so the surface point under the
    // cursor stays under the cursor. Magnified icons are drawn as clones in
    // Main.uiGroup (so they can paint outside the dock), and every value is
    // eased exponentially per frame - nothing ever jumps to its target,
    // which is what gives the dock its liquid feel. When the pointer leaves,
    // the row and the clones relax back to rest with the same easing.
    // --------------------------------------------------------------------

    /** Start the frame loop that drives the magnification. */
    _pulsarMagnifyStart() {
        if (this._pulsarMagFrameId)
            return;

        this._pulsarMagFrameId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW,
            () => {
                if (!Docking.DockManager.settings.dockMagnification ||
                    !this._boxContainer?.mapped) {
                    this._pulsarMagFrameId = 0;
                    this._pulsarMagLastPass = 0;
                    this._pulsarMagActive = false;
                    return GLib.SOURCE_REMOVE;
                }

                const settled = this._pulsarMagnifyPass();
                if (settled && !this._pulsarMagActive) {
                    this._pulsarMagFrameId = 0;
                    this._pulsarMagLastPass = 0;
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            });
    }

    /** Stop the frame loop (dock hiding, feature teardown). */
    _pulsarMagnifyStop() {
        if (this._pulsarMagFrameId) {
            global.compositor.get_laters().remove(this._pulsarMagFrameId);
            this._pulsarMagFrameId = 0;
        }

        this._pulsarMagLastPass = 0;
        this._pulsarMagActive = false;
    }

    /**
     * Exponential easing factor for this frame: the same first-order filter
     * simple-taskbar uses (tau = settle time / 2), so the motion is smooth
     * and independent of the frame rate.
     */
    _pulsarMagnifyFactor() {
        const now = GLib.get_monotonic_time();
        const previous = this._pulsarMagLastPass;
        this._pulsarMagLastPass = now;

        const timeConstant = PULSAR_MAGNIFY_SETTLE_MS /
            PULSAR_MAGNIFY_TIME_CONSTANTS / 1000;
        if (!previous)
            return 0;

        return 1 - Math.exp(-(now - previous) / 1000000 / timeConstant);
    }

    /** Ease every property of `actor` towards `targets`; true when settled. */
    _pulsarMagnifyEase(actor, targets, factor) {
        let settled = true;

        for (const property of Object.keys(targets)) {
            actor.remove_transition?.(property);

            const target = targets[property];
            const current = actor[property];
            const next = current + (target - current) * factor;

            if (Math.abs(target - next) < PULSAR_MAGNIFY_EPSILON) {
                actor[property] = target;
                continue;
            }

            actor[property] = next;
            settled = false;
        }

        return settled;
    }

    /** True while the pointer is close enough to the dock to magnify it. */
    _pulsarMagnifyContains(pointerX, pointerY) {
        const container = this._boxContainer;
        if (!container?.mapped)
            return false;

        // PULSAR-GG4A -- PulsarOS Golden Gate: the hover region is the icon
        // bar, grown by the magnification along the dock axis (so the
        // pointer can step onto the outer half of an end icon without the
        // whole row collapsing away from under it) and towards the screen
        // edge on the dock side.
        const [boxX, boxY] = container.get_transformed_position();
        const [boxWidth, boxHeight] = container.get_transformed_size();
        if (![boxX, boxY, boxWidth, boxHeight].every(Number.isFinite) ||
            boxWidth <= 0 || boxHeight <= 0)
            return false;

        const minX = boxX;
        const minY = boxY;
        const maxX = boxX + boxWidth;
        const maxY = boxY + boxHeight;

        const iconSize = this.iconSize || 48;
        const zoom = Math.max(1,
            Docking.DockManager.settings.magnificationSizeFactor ||
            PULSAR_MAGNIFY_ZOOM);

        // PULSAR-GG7 -- the perpendicular band follows the *icon widgets*,
        // the same source actor the magnifying clone mirrors -- not their
        // item containers. The container keeps its rest size while the
        // clone pivots on the bar side and grows into the air, and it
        // carries the running-dot space below the icon; measured off the
        // containers the band therefore stopped below the magnified tops
        // (top stop too low) and ran past the icon bottoms (bottom stop
        // too low).
        let iconNear = Infinity;
        let iconFar = -Infinity;
        for (const container of this._box.get_children()) {
            if (!container.visible || container.animatingOut)
                continue;
            // App icons are wrapped in a DashItemContainer, while the Show
            // Apps button and the minimized window previews *are* the item.
            const delegate = container.icon
                ? container
                : (container.child ?? container);
            if (!delegate)
                continue;
            // No mapped/visible test on the source: magnification hides the
            // real icon widget while its clone stands in, and the band has
            // to keep covering those magnified icons.
            const source = delegate.icon?._iconBin ??
                delegate.icon ??
                delegate._previewBin ??
                delegate;
            const [ix, iy] = source.get_transformed_position();
            const [iw, ih] = source.get_transformed_size();
            if (![ix, iy, iw, ih].every(Number.isFinite) ||
                iw <= 0 || ih <= 0)
                continue;
            if (this._isHorizontal) {
                iconNear = Math.min(iconNear, iy);
                iconFar = Math.max(iconFar, iy + ih);
            } else {
                iconNear = Math.min(iconNear, ix);
                iconFar = Math.max(iconFar, ix + iw);
            }
        }
        if (!Number.isFinite(iconNear))
            return false;

        // PULSAR-GG6A -- entering needs a touch of the icons, leaving needs
        // a hair of a step, so a pointer resting on the boundary cannot
        // flicker the row.
        const perp = this._pulsarMagActive
            ? PULSAR_MAGNIFY_PERP_LEAVE : PULSAR_MAGNIFY_PERP_ENTER;
        const growth = iconSize * (zoom - 1);
        // While the row is magnified the band also covers what the clones
        // grow into: each clone pivots on the bar side and extends `growth`
        // into the air on the opposite side, so that side's stop level is
        // the far edge of the tallest magnified icon. Only while magnifying:
        // cold, the dock must not light up from half an icon-height away.
        const air = this._pulsarMagActive ? growth : 0;
        const axisMargin = iconSize / 2 +
            (this._pulsarMagActive ? PULSAR_MAGNIFY_LEAVE_MARGIN : 0);

        // Along the dock axis the region stays generous: the pointer may
        // walk past the ends of the bar onto the outer half of Finder/
        // Trash. Perpendicular to it, only the icons themselves count.
        let left;
        let right;
        let top;
        let bottom;

        if (this._isHorizontal) {
            left = minX - axisMargin - growth;
            right = maxX + axisMargin + growth;
            top = iconNear - perp;
            bottom = iconFar + perp;
            if (this._position === St.Side.BOTTOM)
                top -= air;
            else if (this._position === St.Side.TOP)
                bottom += air;
        } else {
            top = minY - axisMargin - growth;
            bottom = maxY + axisMargin + growth;
            left = iconNear - perp;
            right = iconFar + perp;
            if (this._position === St.Side.RIGHT)
                left -= air;
            else if (this._position === St.Side.LEFT)
                right += air;
        }

        return pointerX >= left && pointerX < right &&
            pointerY >= top && pointerY < bottom;
    }

    /**
     * PulsarOS Golden Gate: the gap between the magnified icons.
     *
     * True while the pointer is resting on the magnified icons, including the
     * part of them that grows past the ends of the bar. The dock has to stay
     * visible then (macOS does the same): otherwise reaching for a magnified
     * icon would hide the very icon under the pointer.
     */
    _pulsarMagnifyHoverActive() {
        if (!Docking.DockManager.settings.dockMagnification)
            return false;

        // PULSAR-GG4C -- a frozen launch keeps the dock up even with the
        // pointer far away: the icons stay magnified until the app opens.
        if (this._pulsarMagLaunchPin)
            return true;

        if (!this._pulsarMagActive && !this._pulsarMagHovering)
            return false;

        const [pointerX, pointerY] = global.get_pointer();
        return this._pulsarMagnifyContains(pointerX, pointerY);
    }

    /**
     * The row of dock items along the dock axis, with their *base* geometry:
     * the slide applied by the magnification itself is discounted so the
     * curve never feeds back into its own input.
     */
    _pulsarMagnifyRow() {
        const row = [];

        // PULSAR-GG4F -- the Show Applications button is not part of the
        // dock any more (it is dropped by gsettings), so the row is just
        // the icon box.
        const containers = [...this._box.get_children()];

        for (const container of containers) {
            if (container.animatingOut)
                continue;

            // App icons are wrapped in a DashItemContainer, while the Show
            // Apps button and the minimized window previews *are* the item.
            const delegate = container.icon
                ? container
                : (container.child ?? container);
            if (!delegate)
                continue;

            const sourceActor =
                delegate.icon?._iconBin ??
                delegate.icon ??
                delegate._previewBin ??
                delegate;
            if (!sourceActor?.mapped)
                continue;

            const [x, y] = container.get_transformed_position();
            const [width, height] = container.get_transformed_size();
            if (![x, y, width, height].every(Number.isFinite) ||
                width <= 0 || height <= 0)
                continue;

            const applied = this._isHorizontal
                ? container.translation_x
                : container.translation_y;

            row.push({
                container,
                delegate,
                sourceActor,
                // The widget that stands down while the floating clone plays
                // the icon. Hiding the icon widget (never the cloned bin)
                // keeps click targets and the clone itself intact.
                originalVisual: delegate.icon ?? container,
                // App icons, location tiles (Trash, Downloads), the Show
                // Apps button and the minimized-window previews magnify;
                // separators only travel with the row.
                magnifies: Boolean(delegate.icon) ||
                    container instanceof DockMinimizedWindowItem,
                length: this._isHorizontal ? width : height,
                center: (this._isHorizontal
                    ? x + width / 2
                    : y + height / 2) - applied,
                level: 0,
                growth: 0,
                translation: 0,
            });
        }

        row.sort((left, right) => left.center - right.center);
        return row;
    }

    /** Where a cursor position lands on the magnified row. */
    _pulsarMagnifyMapCursor(row, cursor) {
        const first = row[0];
        if (cursor <= first.center)
            return first.shifted - (first.center - cursor);

        for (let index = 1; index < row.length; index++) {
            const previous = row[index - 1];
            const current = row[index];
            if (cursor > current.center)
                continue;

            const span = current.center - previous.center;
            const progress = span > 0
                ? (cursor - previous.center) / span
                : 0;
            return previous.shifted +
                progress * (current.shifted - previous.shifted);
        }

        const last = row[row.length - 1];
        return last.shifted + (cursor - last.center);
    }

    /** Keep the magnified row inside the monitor work area. */
    _pulsarMagnifyClampOffset(row, offset) {
        const monitor =
            Main.layoutManager.findMonitorForActor(this._boxContainer) ??
            Main.layoutManager.primaryMonitor;
        if (!monitor)
            return offset;

        const workArea =
            Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const start = this._isHorizontal ? workArea.x : workArea.y;
        const end = start + (this._isHorizontal
            ? workArea.width
            : workArea.height);

        const first = row[0];
        const last = row[row.length - 1];
        const rowStart = first.shifted - (first.length + first.growth) / 2;
        const rowEnd = last.shifted + (last.length + last.growth) / 2;

        const minimum = start - rowStart;
        const maximum = end - rowEnd;
        if (minimum > maximum)
            return offset;

        return Math.min(Math.max(offset, minimum), maximum);
    }

    /**
     * Ease the row spread back to rest (used when the dock slides away).
     *
     * PULSAR-GG4D -- while the frame loop runs it is the *only* writer
     * of the row translations: handing the same properties to a Clutter
     * transition as well made them oscillate between two writers, and
     * the dock visibly trembled.
     */
    _pulsarMagnifyRelaxRow(duration) {
        if (this._pulsarMagFrameId) {
            this._pulsarMagActive = false;
            return;
        }

        for (const container of this._box.get_children()) {
            const property = this._isHorizontal
                ? 'translation_x'
                : 'translation_y';
            if (!container[property])
                continue;

            container.remove_transition?.(property);
            container.ease({
                [property]: 0,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /**
     * PULSAR-GG8 -- the floating icon that stands in for a magnified dock
     * icon, rendered sharp.
     *
     * The obvious choice, a ClutterClone of the icon already on screen,
     * magnifies a *picture*: the widget was laid out at the resting size
     * (48px by default) and the clone scales that raster up to twice its
     * size, so the hovered icons went soft while the resting ones stayed
     * sharp. Instead the icon is rendered again at the largest size it will
     * ever reach (resting size × zoom) and that texture is drawn inside a
     * slot-sized wrapper: at rest the wrapper shows it scaled *down* to the
     * dock size, at full magnification the two scales cancel and it is 1:1
     * with its own texture. The wrapper keeps the exact slot geometry the
     * clone had, so the row spread, the launch bounce and the retreat keep
     * working untouched.
     *
     * Only real application icons can be re-rendered: the Show Apps tile and
     * the minimised-window previews have no texture to ask for, so they keep
     * the plain clone.
     */
    _pulsarMagnifyVisual(entry) {
        const delegate = entry.delegate;
        const icon = delegate?.icon;
        const app = delegate?.app;
        const realIcon = icon?.icon;

        if (!app?.create_icon_texture || !realIcon ||
            entry.sourceActor !== icon._iconBin) {
            return new Clutter.Clone({
                source: entry.sourceActor,
                reactive: false,
            });
        }

        const zoom = Math.max(1,
            Docking.DockManager.settings.magnificationSizeFactor ||
            PULSAR_MAGNIFY_ZOOM);
        let themeScale = 1;
        try {
            themeScale =
                St.ThemeContext.get_for_stage(global.stage).scaleFactor || 1;
        } catch {}

        const slot = this.iconSize || 48;
        const hiRes = Math.min(512,
            Math.max(2, Math.ceil(slot * zoom * themeScale)));

        let hiResIcon = null;
        try {
            hiResIcon = app.create_icon_texture(hiRes);
        } catch {
            hiResIcon = null;
        }
        if (!hiResIcon) {
            return new Clutter.Clone({
                source: entry.sourceActor,
                reactive: false,
            });
        }

        // A fixed size, so a layout manager on the wrapper can never shrink
        // the texture back to the dock size (which would defeat the point).
        hiResIcon.set_size(hiRes, hiRes);
        hiResIcon.set_pivot_point(0.5, 0.5);
        if (typeof realIcon.get_style_class_name === 'function') {
            const styleClass = realIcon.get_style_class_name();
            if (styleClass)
                hiResIcon.set_style_class_name(styleClass);
        }

        const wrapper = new Clutter.Actor({
            reactive: false,
            clip_to_allocation: false,
            width: slot,
            height: slot,
        });
        wrapper.add_child(hiResIcon);
        wrapper._pulsarHiRes = hiRes;
        wrapper._pulsarHiResIcon = hiResIcon;
        this._pulsarMagnifyFitHiRes(wrapper, slot, slot);

        return wrapper;
    }

    /** Center the high-resolution texture inside a slot of the given size. */
    _pulsarMagnifyFitHiRes(actor, width, height) {
        const hiRes = actor._pulsarHiRes;
        const icon = actor._pulsarHiResIcon;
        if (!hiRes || !icon || icon.is_finalized?.())
            return;

        const scale = Math.min(width / hiRes, height / hiRes);
        icon.set_position((width - hiRes) / 2, (height - hiRes) / 2);
        icon.set_scale(scale, scale);
    }

    /** Restore an icon to its resting look (real widget visible, no clone). */
    _pulsarMagnifyRelease(entry) {
        const icon = entry.delegate;
        const clone = this._pulsarMagnificationClones?.get(icon);

        if (clone) {
            this._pulsarMagnificationClones.delete(icon);
            clone.destroy();
        }

        if (icon._pulsarMagnifyClone === clone)
            icon._pulsarMagnifyClone = null;

        const visual = icon._pulsarMagnifyHidden ??
            icon.icon ?? entry.originalVisual ?? entry.sourceActor;
        if (visual)
            visual.opacity = 255;

        icon._pulsarMagnifyHidden = null;
    }

    /**
     * Hide the real dock icon while its floating clone stands in for it,
     * keeping the dock item itself alive so hover/click/layout still work.
     *
     * Some paths (a dock rebuild, a spurious leave/reset race) can restore
     * the real icon to 255 for a frame, which would show it underneath the
     * lifted clone: the click "duplicate". The guard re-hides it whenever it
     * is revealed while a visible clone (or a launch bounce) owns the icon.
     * `_pulsarResetting` stands the guard down during _resetMagnification,
     * where the real icons are intentionally restored first.
     */
    _pulsarMagnifyHideOriginal(entry, clone) {
        const icon = entry.delegate;
        const originalVisual =
            icon._pulsarMagnifyHidden ?? entry.originalVisual;
        if (!originalVisual)
            return;

        icon._pulsarMagnifyHidden = originalVisual;

        if (!icon._pulsarOpWatched) {
            icon._pulsarOpWatched = true;
            try {
                originalVisual.connect('notify::opacity', () => {
                    if (this._pulsarResetting)
                        return;
                    if (originalVisual.opacity !== 0 &&
                        (icon._bouncing ||
                         (icon._pulsarMagnifyClone &&
                          !icon._pulsarMagnifyClone.is_finalized?.() &&
                          icon._pulsarMagnifyClone.visible)))
                        originalVisual.opacity = 0;
                });
            } catch {}
        }

        originalVisual.opacity = 0;
    }

    /**
     * One frame of the magnification. Returns true once everything (row
     * spread and every clone) has come to rest with the pointer away.
     */
    _pulsarMagnifyPass() {
        const settings = Docking.DockManager.settings;
        if (!settings.dockMagnification) {
            this._resetMagnification();
            return true;
        }

        const factor = this._pulsarMagnifyFactor();
        const [pointerX, pointerY] = global.get_pointer();
        const contains = this._pulsarMagnifyContains(pointerX, pointerY);

        // PULSAR-GG4B -- the pointer drives the row only while it is
        // inside the dock; a popup menu owns the dock while open. A
        // frozen launch keeps the row alive even with the pointer away.
        if ((!contains && !this._pulsarMagLaunchPin) ||
            this._pulsarMagMenuOpen)
            this._pulsarMagActive = false;

        // PULSAR-GG5B -- the freeze lives exactly as long as the launch
        // bounce: the row stays big while the icon jumps and returns to
        // rest the moment the bounce settles. An icon that never jumped
        // (a focus or minimise click) gets a short grace, then lets go.
        if (this._pulsarMagLaunchPin) {
            const icon = this._pulsarMagLaunchIcon;
            if (!icon || icon.is_finalized?.()) {
                this._pulsarMagnifyUnpinLaunch();
            } else if (icon._bouncing) {
                this._pulsarMagLaunchBounced = true;
                this._pulsarMagLaunchGrace = 0;
            } else if (this._pulsarMagLaunchBounced) {
                this._pulsarMagnifyUnpinLaunch();
            } else if (++this._pulsarMagLaunchGrace >
                    PULSAR_MAGNIFY_LAUNCH_GRACE_FRAMES) {
                this._pulsarMagnifyUnpinLaunch();
            }
        }

        // PULSAR-GG5B -- touching the dock while the icon still jumps
        // hands the *pointer* back: the pose is dropped and re-snapshotted
        // every frame the row tracks, so leaving again re-freezes it. The
        // freeze itself only ends when the bounce settles.
        if (this._pulsarMagLaunchPin && contains && !this._pulsarMagMenuOpen) {
            if (this._pulsarMagLaunchIcon?._bouncing)
                this._pulsarMagFrozenPose = null;
            else
                this._pulsarMagnifyUnpinLaunch();
        }

        const row = this._pulsarMagnifyRow();
        if (!row.length)
            this._pulsarMagActive = false;

        this._pulsarMagnificationClones ??= new Map();

        const iconSize = this.iconSize || 48;
        const zoom = Math.max(1,
            settings.magnificationSizeFactor || PULSAR_MAGNIFY_ZOOM);
        const radius = iconSize * PULSAR_MAGNIFY_EXTENT / 2;
        const cursor = this._isHorizontal ? pointerX : pointerY;

        // PulsarOS Golden Gate: while the pointer sits on the magnified icons
        // the dock stays up, even where they grew past the ends of the bar.
        // Whenever that state changes, let the dock re-evaluate its
        // visibility (it hides as soon as the pointer really leaves).
        const hovering = contains && this._pulsarMagActive;
        if (hovering !== this._pulsarMagHovering) {
            this._pulsarMagHovering = hovering;
            this._pulsarDockManager?._updateDashVisibility?.();
        }

        // PULSAR-GG4C -- a frozen row replays the pose the click left.
        const pose = this._pulsarMagLaunchPin
            ? this._pulsarMagFrozenPose : null;

        if (this._pulsarMagActive) {
            for (const entry of row) {
                if (pose) {
                    entry.level = pose.get(entry.container)?.level ?? 0;
                } else {
                    const distance = Math.abs(cursor - entry.center);
                    entry.level = entry.magnifies && distance < radius
                        ? Math.pow(
                            (Math.cos(distance * Math.PI / radius) + 1) / 2,
                            PULSAR_MAGNIFY_CONVEXITY)
                        : 0;
                }
                // macOS keeps the *gap* between the magnified icons equal to
                // the resting one: the row grows by the size the icons
                // themselves gain, not by the size of their slots (which
                // already carry the padding, and would double the gap).
                entry.growth = iconSize * (zoom - 1) * entry.level;
            }

            row[0].shifted = row[0].center;
            for (let index = 1; index < row.length; index++) {
                const previous = row[index - 1];
                const current = row[index];
                current.shifted = previous.shifted +
                    (current.center - previous.center) +
                    (previous.growth + current.growth) / 2;
            }

            if (pose) {
                for (const entry of row)
                    entry.translation =
                        pose.get(entry.container)?.translation ?? 0;
            } else {
                // Pin the surface point under the cursor: shift the whole
                // row so the magnified picture follows the pointer 1:1.
                const offset = this._pulsarMagnifyClampOffset(row,
                    cursor - this._pulsarMagnifyMapCursor(row, cursor));

                for (const entry of row)
                    entry.translation =
                        entry.shifted + offset - entry.center;

                // PULSAR-GG4C -- remember the pose: the launch freeze
                // replays it until the app opens (or the dock is touched).
                this._pulsarMagFrozenPose = new Map(row.map(entry =>
                    [entry.container,
                     {level: entry.level,
                      translation: entry.translation}]));
            }
        }

        let settled = true;
        const slotProperty = this._isHorizontal
            ? 'translation_x'
            : 'translation_y';

        for (const entry of row) {
            // 1) Spread the real item along the dock axis: running dots,
            //    labels and hit areas travel with the magnified picture.
            settled = this._pulsarMagnifyEase(
                entry.container,
                {[slotProperty]: entry.translation},
                factor) && settled;

            if (!entry.magnifies)
                continue;

            const icon = entry.delegate;
            const targetScale = 1 + (zoom - 1) * entry.level;
            let clone = this._pulsarMagnificationClones.get(icon);

            if (clone?._pulsarRetreating) {
                clone.remove_all_transitions?.();
                clone._pulsarRetreating = false;
            }

            // PULSAR-GG4G -- the real icon is clipped by the dock bar, so
            // an entry the cursor lock has pushed sideways must keep its
            // clone even at rest scale: otherwise the far end icons
            // (Finder, Trash) vanished the moment the row shifted them
            // out of the bar and their level dropped to 0. Compare the
            // *applied* translation, not the target: while the row eases
            // back the target is already 0 but the icon is still off.
            const displaced =
                Math.abs(entry.container[slotProperty]) > 0.5 ||
                entry.level > 0.001;

            if (targetScale <= 1.001 && !clone && !icon._bouncing &&
                !displaced) {
                // Nothing to draw: make sure the real icon is visible.
                this._pulsarMagnifyRelease(entry);
                continue;
            }

            // The launch press/bounce runs on the real icon (or on its live
            // clone): don't swap in a fresh 0x0 clone and hide a bouncing
            // icon, and never re-pose a clone the bounce is animating.
            if (!clone && icon._bouncing)
                continue;

            if (!clone) {
                clone = this._pulsarMagnifyVisual(entry);
                clone.clip_to_allocation = false;

                Main.uiGroup.add_child(clone);
                this._pulsarMagnificationClones.set(icon, clone);

                // Hand the floating clone to the dock icon: the launch
                // animation presses and bounces *it* instead of the hidden
                // real icon, so the click never shows a second copy.
                icon._pulsarMagnifyClone = clone;
                icon._pulsarDash = this;

                if (this._position === St.Side.BOTTOM)
                    clone.set_pivot_point(0.5, 1.0);
                else if (this._position === St.Side.TOP)
                    clone.set_pivot_point(0.5, 0.0);
                else if (this._position === St.Side.LEFT)
                    clone.set_pivot_point(0.0, 0.5);
                else
                    clone.set_pivot_point(1.0, 0.5);
            }

            // Keep the back-ref in sync even when the clone survived a
            // reveal pass: the launch animation must always pick the live
            // floating clone as its bounce target.
            icon._pulsarMagnifyClone = clone;

            if (!icon._bouncing) {
                // The clone mirrors the *slot*, which the spread above just
                // moved: re-anchor it every frame so the icon travels with
                // the row while it grows.
                const [sourceX, sourceY] =
                    entry.sourceActor.get_transformed_position();
                const [sourceWidth, sourceHeight] =
                    entry.sourceActor.get_transformed_size();

                // Never stand in for a source with no geometry: the clone
                // would be an invisible 0x0 and the real icon hidden.
                if (![sourceX, sourceY, sourceWidth, sourceHeight]
                    .every(Number.isFinite) ||
                    sourceWidth <= 0 || sourceHeight <= 0) {
                    this._pulsarMagnifyRelease(entry);
                    continue;
                }

                clone.set_position(sourceX, sourceY);
                clone.set_size(sourceWidth, sourceHeight);
                this._pulsarMagnifyFitHiRes(
                    clone, sourceWidth, sourceHeight);

                const cloneSettled = this._pulsarMagnifyEase(clone, {
                    scale_x: targetScale,
                    scale_y: targetScale,
                    translation_x: 0,
                    translation_y: 0,
                }, factor);

                if (targetScale <= 1.001 && cloneSettled && !displaced) {
                    this._pulsarMagnifyRelease(entry);
                    continue;
                }

                settled = cloneSettled && settled;
            }

            clone.show();
            this._pulsarMagnifyHideOriginal(entry, clone);
            Main.uiGroup.set_child_above_sibling(clone, null);
        }

        // Clones whose icon left the dock (or the row) follow them out.
        for (const [icon, clone] of [...this._pulsarMagnificationClones]) {
            if (icon._bouncing)
                continue;
            if (row.some(entry => entry.delegate === icon))
                continue;

            this._pulsarMagnificationClones.delete(icon);
            if (icon._pulsarMagnifyClone === clone)
                icon._pulsarMagnifyClone = null;
            clone.destroy();

            const visual = icon._pulsarMagnifyHidden ?? icon.icon;
            if (visual)
                visual.opacity = 255;
            icon._pulsarMagnifyHidden = null;
        }

        // PULSAR-GG3B -- PulsarOS Golden Gate: the app names ride above the
        // magnified pictures, and the glass panel follows the spread, one
        // side at a time.
        this._pulsarMagnifyPoseLabels(row, zoom);
        this._pulsarMagnifyPublishOverflow(row, zoom);

        return settled && this._pulsarMagnificationClones.size === 0;
    }

    /**
     * PulsarOS Golden Gate: the app names stay *above* the magnified icons.
     *
     * The dock labels are chrome actors living in Main.uiGroup (see
     * DashItemContainer), while the magnified pictures are clones raised on
     * top of everything: the names end up painted under them. Each visible
     * label is re-centred on the magnified picture every frame and raised
     * above the clones, macOS style.
     */
    _pulsarMagnifyPoseLabels(row, zoom) {
        const gap = 6;

        for (const entry of row) {
            const label = entry.container?.label;
            if (!label || !label.visible || label.opacity < 1)
                continue;
            // Only a label sharing the clones' top level can be raised.
            if (label.get_parent() !== Main.uiGroup)
                continue;

            const scale = 1 + (zoom - 1) * entry.level;
            const [x, y] = entry.container.get_transformed_position();
            const [width, height] = entry.container.get_transformed_size();
            if (![x, y, width, height].every(Number.isFinite))
                continue;

            const centerX = x + width / 2;
            const centerY = y + height / 2;

            // The picture scales about the same pivot the clone uses: the
            // bar-side edge stays put and the rest grows off the bar.
            let top = centerY - (height * scale) / 2;
            let bottom = centerY + (height * scale) / 2;
            let left = centerX - (width * scale) / 2;
            let right = centerX + (width * scale) / 2;

            if (this._position === St.Side.BOTTOM)
                top = (y + height) - (height * scale);
            else if (this._position === St.Side.TOP)
                bottom = y + (height * scale);
            else if (this._position === St.Side.LEFT)
                right = x + (width * scale);
            else
                left = (x + width) - (width * scale);

            let labelX = centerX - label.width / 2;
            let labelY = centerY - label.height / 2;

            if (this._position === St.Side.BOTTOM)
                labelY = top - label.height - gap;
            else if (this._position === St.Side.TOP)
                labelY = bottom + gap;
            else if (this._position === St.Side.LEFT)
                labelX = left - label.width - gap;
            else
                labelX = right + gap;

            const monitor =
                Main.layoutManager.findMonitorForActor(entry.container);
            if (monitor) {
                labelX = Math.clamp(labelX, monitor.x,
                    monitor.x + monitor.width - label.width);
                labelY = Math.clamp(labelY, monitor.y,
                    monitor.y + monitor.height - label.height);
            }

            label.set_position(labelX, labelY);
            Main.uiGroup.set_child_above_sibling(label, null);
        }
    }

    /**
     * PulsarOS Golden Gate: the dock panel follows the magnified icons.
     *
     * Publishes how far the spread row spills past the bar on each side of
     * the dock axis, in screen pixels. The liquid glass dock manager reads
     * `dashContainer._pulsarMagnifyOverflow` and grows its panel towards the
     * icons, one side at a time; with no spill every value is 0 and the
     * panel keeps its resting shape.
     */
    _pulsarMagnifyPublishOverflow(row, zoom) {
        const target = this._dashContainer;
        if (!target)
            return;

        const overflow = {left: 0, right: 0, top: 0, bottom: 0};

        // PULSAR-GG4A -- measure the spill against the *bar* (the dash
        // container the glass panel is built on), not against the icon
        // box: the box is inset inside the bar, so measuring the box made
        // the panel grow by the inset plus the spill, and the dock ended
        // up visibly too long on one side.
        const bar = this._dashContainer;

        if (bar?.mapped && row.length) {
            const [barX, barY] = bar.get_transformed_position();
            const [barWidth, barHeight] = bar.get_transformed_size();
            const horizontal = this._isHorizontal;
            const barStart = horizontal ? barX : barY;
            const barEnd = horizontal ? barX + barWidth : barY + barHeight;

            let start = Infinity;
            let end = -Infinity;
            for (const entry of row) {
                if (!entry.container?.mapped)
                    continue;
                const scale = 1 + (zoom - 1) * entry.level;
                const length = entry.length * scale;
                const center = entry.center + entry.translation;
                start = Math.min(start, center - length / 2);
                end = Math.max(end, center + length / 2);
            }

            // A little glass past the icons where they leave the bar, so they
            // never touch the panel's edge.
            const pad = PULSAR_MAGNIFY_PANEL_PAD;
            if (Number.isFinite(start) && Number.isFinite(end)) {
                const before = barStart - start;
                const after = end - barEnd;
                if (horizontal) {
                    overflow.left = before > 0 ? before + pad : 0;
                    overflow.right = after > 0 ? after + pad : 0;
                } else {
                    overflow.top = before > 0 ? before + pad : 0;
                    overflow.bottom = after > 0 ? after + pad : 0;
                }
            }
        }

        // PULSAR-GG4A -- ease the published values: the panel is rebuilt
        // from them on every frame, and values that jumped around made
        // the glass edge tremble. Rounding stops the shader from chasing
        // sub-pixel noise; the resting state stays exactly 0.
        let out = overflow;
        if (row.length) {
            const previous = this._pulsarMagnifyOverflowSmoothed;
            out = {};
            for (const side of ['left', 'right', 'top', 'bottom']) {
                const value = overflow[side];
                const next = previous
                    ? previous[side] + (value - previous[side]) *
                        PULSAR_MAGNIFY_OVERFLOW_EASE
                    : value;
                out[side] = Math.abs(next - value) < 0.5
                    ? value
                    : Math.round(next * 2) / 2;
            }
        }

        this._pulsarMagnifyOverflowSmoothed = out;
        target._pulsarMagnifyOverflow = out;
    }

    _pulsarReapplyMagnification() {
        if (!this._pulsarPointerInDock ||
            this._pulsarPointerX === null ||
            !Docking.DockManager.settings.dockMagnification)
            return;

        this._pulsarMagRetreating = false;

        if (!this._pulsarMagnifyContains(
            this._pulsarPointerX, this._pulsarPointerY))
            return;

        this._pulsarMagActive = true;
        this._pulsarMagLastPass = 0;
        this._pulsarMagnifyStart();
    }

    /**
     * PulsarOS Golden Gate: keep the row magnified while an app opens.
     *
     * Clicking an app icon launches it: the icons stay spread (even if
     * the pointer already left the dock) while the icon plays its launch
     * bounce, and the row returns to rest the moment the bounce settles,
     * so the click never collapses the dock under the finger. The timeout
     * is only a safety cap for launches that never open anything.
     */
    _pulsarMagnifyPinLaunch(appIcon) {
        const app = appIcon?.app;
        if (!app)
            return;

        // PULSAR-GG5C -- a popup menu or the Downloads fan owns the row;
        // never arm the launch freeze behind them (the fan's click lands
        // here right after it opened).
        if (this._pulsarMagMenuOpen)
            return;

        // PULSAR-GG4C -- re-arm the watch *without* dropping the pose the
        // row is holding: the freeze replays it until the app opens.
        if (this._pulsarMagLaunchTimeout) {
            GLib.source_remove(this._pulsarMagLaunchTimeout);
            this._pulsarMagLaunchTimeout = 0;
        }
        if (this._pulsarMagLaunchWatch) {
            const {app: watched, id} = this._pulsarMagLaunchWatch;
            this._pulsarMagLaunchWatch = null;
            try {
                watched.disconnect(id);
            } catch (_error) {
                // The app object may already be gone; nothing to undo.
            }
        }

        // PULSAR-GG5B -- the freeze is armed only while the icon jumps:
        // animateLaunch ran synchronously inside this same click, so the
        // bounce state here is the one the pass has to watch.
        this._pulsarMagLaunchIcon = appIcon;
        this._pulsarMagLaunchBounced = Boolean(appIcon._bouncing);
        this._pulsarMagLaunchGrace = 0;
        this._pulsarMagLaunchPin = Boolean(this._pulsarMagFrozenPose);
        this._pulsarMagLaunchTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, PULSAR_MAGNIFY_LAUNCH_PIN_MS, () => {
                this._pulsarMagnifyUnpinLaunch();
                return GLib.SOURCE_REMOVE;
            });

        const windowsChangedId = app.connect('windows-changed', () => {
            if (!this._pulsarMagLaunchPin || app.get_n_windows() > 0)
                this._pulsarMagnifyUnpinLaunch();
        });
        this._pulsarMagLaunchWatch = {app, id: windowsChangedId};

        // The click itself never relaxes the row: re-assert it.
        if (this._pulsarPointerInDock)
            this._pulsarReapplyMagnification();
    }

    _pulsarMagnifyUnpinLaunch() {
        // PULSAR-GG5B -- forget the launching icon: the freeze is over.
        this._pulsarMagLaunchPin = false;
        this._pulsarMagLaunchIcon = null;
        this._pulsarMagLaunchBounced = false;
        this._pulsarMagLaunchGrace = 0;
        this._pulsarMagFrozenPose = null;

        if (this._pulsarMagLaunchTimeout) {
            GLib.source_remove(this._pulsarMagLaunchTimeout);
            this._pulsarMagLaunchTimeout = 0;
        }
        if (this._pulsarMagLaunchWatch) {
            const {app, id} = this._pulsarMagLaunchWatch;
            this._pulsarMagLaunchWatch = null;
            try {
                app.disconnect(id);
            } catch (_error) {
                // The app object may already be gone; nothing to undo.
            }
        }
    }

    /**
     * PulsarOS Golden Gate: a popup menu owns the dock while it is open.
     *
     * The Downloads and Trash lists open *over* the dock: the magnified
     * icons are released so the menu is presented against the resting row,
     * instead of floating over icons that keep shifting underneath it.
     */
    _pulsarMagnifySetMenuOpen(opened) {
        const menuOpen = Boolean(opened);
        if (this._pulsarMagMenuOpen === menuOpen)
            return;

        this._pulsarMagMenuOpen = menuOpen;
        if (!this._pulsarMagMenuOpen)
            return;

        this._pulsarMagActive = false;
        this._pulsarMagnifyUnpinLaunch();
        this._pulsarMagnifyRelaxRow(PULSAR_MAGNIFY_MENU_RELAX_MS);
    }

    _pulsarCleanupClone(icon) {
        if (!this._pulsarMagnificationClones)
            return;
        const clone = this._pulsarMagnificationClones.get(icon);
        if (clone) {
            this._pulsarMagnificationClones.delete(icon);
            clone.destroy();
        }
        if (icon._pulsarMagnifyClone === clone)
            icon._pulsarMagnifyClone = null;
        const visual = icon._pulsarMagnifyHidden ??
            icon.icon ?? (icon.icon?._iconBin ?? icon);
        if (visual)
            visual.opacity = 255;
        icon._pulsarMagnifyHidden = null;
    }

    /**
     * Golden Gate: retreat the hover magnification the way the macOS dock
     * does when it slides away - icons shrink and sink together with the bar
     * over the same duration and easing as the slide, instead of snapping
     * back to rest size in a single frame.
     */
    _pulsarRetreatMagnification() {
        this._pulsarMagnifyStop();
        this._pulsarMagRetreating = true;

        const duration = Math.round(
            (Docking.DockManager.settings.animationTime || 0.25) * 1000);

        this._pulsarMagnifyRelaxRow(duration);

        if (!this._pulsarMagnificationClones ||
            this._pulsarMagnificationClones.size === 0)
            return;
        const drop = this._boxContainer?.height || 90;

        let dx = 0;
        let dy = 0;
        if (this._position === St.Side.BOTTOM)
            dy = drop;
        else if (this._position === St.Side.TOP)
            dy = -drop;
        else if (this._position === St.Side.LEFT)
            dx = -drop;
        else
            dx = drop;

        for (const [icon, clone] of this._pulsarMagnificationClones) {
            if (clone.is_finalized?.() || clone._pulsarRetreating)
                continue;

            if (icon._bouncing) {
                clone.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    translation_x: 0,
                    duration: Math.min(duration, 160),
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                continue;
            }

            if (icon._pulsarMagnifyClone === clone)
                icon._pulsarMagnifyClone = null;

            clone._pulsarRetreating = true;
            clone.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                translation_x: dx !== 0 ? clone.translation_x + dx : 0,
                translation_y: dy !== 0 ? clone.translation_y + dy : 0,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (!clone.is_finalized?.())
                        clone.destroy();
                    this._pulsarMagnificationClones?.delete(icon);
                    if (icon._bouncing)
                        return;

                    const visual = icon._pulsarMagnifyHidden ??
                        icon.icon ?? icon;
                    if (visual)
                        visual.opacity = 255;
                    icon._pulsarMagnifyHidden = null;
                },
            });
        }
    }

    _resetMagnification() {
        this._pulsarMagnifyStop();
        this._pulsarMagRetreating = false;
        this._pulsarMagFrozenPose = null;
        this._pulsarMagnifyOverflowSmoothed = null;
        this._pulsarMagnifyPublishOverflow([], 1);

        // Teardown path (feature disabled, dock destroyed): drop the row
        // spread at once instead of animating it.
        for (const container of this._box.get_children()) {
            const property = this._isHorizontal
                ? 'translation_x'
                : 'translation_y';
            container.remove_transition?.(property);
            container[property] = 0;
        }

        const appIcons = this.getAppIcons();

        // See the opacity guard in _pulsarMagnifyHideOriginal: it must stand
        // down while we deliberately restore the icons below, otherwise it
        // re-hides each real icon right before its clone is destroyed.
        this._pulsarResetting = true;

        appIcons.forEach(icon => {
            if (icon._bouncing)
                return;

            const sourceActor =
                icon.icon?._iconBin ??
                icon.icon ??
                icon._previewBin ??
                icon;

            for (const actor of [icon, sourceActor, icon.icon]) {
                if (!actor)
                    continue;

                actor.remove_transition?.('scale-x');
                actor.remove_transition?.('scale-y');
                actor.remove_transition?.('translation-x');
                actor.remove_transition?.('translation-y');

                actor.scale_x = 1.0;
                actor.scale_y = 1.0;
                actor.translation_x = 0;
                actor.translation_y = 0;
                actor.opacity = 255;
            }

            icon._pulsarMagnifyHidden = null;
        });

        if (this._pulsarMagnificationClones) {
            for (const [icon, clone] of this._pulsarMagnificationClones) {
                if (icon._bouncing) {
                    clone.ease({
                        scale_x: 1.0,
                        scale_y: 1.0,
                        translation_x: 0,
                        duration: 120,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                    continue;
                }

                if (icon._pulsarMagnifyClone === clone)
                    icon._pulsarMagnifyClone = null;

                clone.destroy();
                this._pulsarMagnificationClones.delete(icon);
            }
        }

        this._pulsarResetting = false;
    }

    /**
     * Return an array with all interactive icons currently in the dash
     */
    getAppIcons() {
        const result = [];
        const children = this._box.get_children();
        children.forEach(actor => {
            if (actor.animatingOut)
                return;
            if (actor.child && actor.child.icon) {
                result.push(actor.child);
            } else if (actor instanceof DockMinimizedWindowItem) {
                result.push(actor);
            }
        });

        if (this._showAppsIcon && this._showAppsIcon.visible) {
            result.push(this._showAppsIcon);
        }

        return result;
    }

    _itemMenuStateChanged(item, opened) {
        Dash.Dash.prototype._itemMenuStateChanged.call(this, item, opened);

        if (opened) {
            this.emit('menu-opened');
        } else {
            // I want to listen from outside when a menu is closed. I used to
            // add a custom signal to the appIcon, since gnome 3.8 the signal
            // calling this callback was added upstream.
            this.emit('menu-closed');
        }
    }

    _adjustIconSize() {
        // For the icon size, we only consider children which are "proper"
        // icons (i.e. ignoring drag placeholders) and which are not
        // animating out (which means they will be destroyed at the end of
        // the animation)
        const iconChildren = this._box.get_children().filter(actor => {
            return actor.child &&
                   actor.child._delegate &&
                   actor.child._delegate.icon &&
                   !actor.animatingOut;
        });

        iconChildren.push(this._showAppsIcon);

        if (this._maxWidth === -1 && this._maxHeight === -1)
            return;

        // Check if the container is present in the stage. This avoids critical
        // errors when unlocking the screen
        if (!this._container.get_stage())
            return;

        const themeNode = this._dashContainer.get_theme_node();
        const maxAllocation = new Clutter.ActorBox({
            x1: 0,
            y1: 0,
            x2: this._isHorizontal ? this._maxWidth : 42 /* whatever */,
            y2: this._isHorizontal ? 42 : this._maxHeight,
        });
        const maxContent = themeNode.get_content_box(maxAllocation);
        let availSpace;
        if (this._isHorizontal)
            availSpace = maxContent.get_width();
        else
            availSpace = maxContent.get_height();

        const spacing = themeNode.get_length('spacing');

        const [{child: firstButton}] = iconChildren;
        const {child: firstIcon} = firstButton?.icon ?? {child: null};

        // if no icons there's nothing to adjust
        if (!firstIcon)
            return;

        // Enforce valid spacings during the size request
        firstIcon.ensure_style();
        const [, , iconWidth, iconHeight] = firstIcon.get_preferred_size();
        const [, , buttonWidth, buttonHeight] = firstButton.get_preferred_size();

        if (this._isHorizontal) {
            // Subtract icon padding and box spacing from the available width
            availSpace -= iconChildren.length * (buttonWidth - iconWidth) +
                           (iconChildren.length - 1) * spacing;

            if (this._separator) {
                const [, , separatorWidth] = this._separator.get_preferred_size();
                availSpace -= separatorWidth + spacing;
            }
        } else {
            // Subtract icon padding and box spacing from the available height
            availSpace -= iconChildren.length * (buttonHeight - iconHeight) +
                           (iconChildren.length - 1) * spacing;

            if (this._separator) {
                const [, , , separatorHeight] = this._separator.get_preferred_size();
                availSpace -= separatorHeight + spacing;
            }
        }

        const maxIconSize = availSpace / iconChildren.length;
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const iconSizes = this._availableIconSizes.map(s => s * scaleFactor);

        let [newIconSize] = this._availableIconSizes;
        for (let i = 0; i < iconSizes.length; i++) {
            if (iconSizes[i] <= maxIconSize)
                newIconSize = this._availableIconSizes[i];
        }

        if (newIconSize === this.iconSize)
            return;

        const oldIconSize = this.iconSize;
        this.iconSize = newIconSize;
        this.emit('icon-size-changed');

        const scale = oldIconSize / newIconSize;
        for (let i = 0; i < iconChildren.length; i++) {
            const {icon} = iconChildren[i].child._delegate;

            // Set the new size immediately, to keep the icons' sizes
            // in sync with this.iconSize
            icon.setIconSize(this.iconSize);

            // Don't animate the icon size change when the overview
            // is transitioning, not visible or when initially filling
            // the dash
            if (!Main.overview.visible || Main.overview.animationInProgress ||
                !this._shownInitially)
                continue;

            const [targetWidth, targetHeight] = icon.icon.get_size();

            // Scale the icon's texture to the previous size and
            // tween to the new size
            icon.icon.set_size(icon.icon.width * scale,
                icon.icon.height * scale);

            icon.icon.ease({
                width: targetWidth,
                height: targetHeight,
                duration: DASH_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        if (this._separator) {
            const animateProperties = this._isHorizontal
                ? {height: this.iconSize} : {width: this.iconSize};

            this._separator.ease({
                ...animateProperties,
                duration: DASH_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _redisplay() {
        const favorites = AppFavorites.getAppFavorites().getFavoriteMap();

        let running = this._appSystem.get_running();
        const dockManager = Docking.DockManager.getDefault();
        const {settings} = dockManager;

        this._scrollView.set({
            xAlign: Clutter.ActorAlign.FILL,
            yAlign: Clutter.ActorAlign.FILL,
        });
        if (dockManager.settings.dockExtended) {
            if (!this._isHorizontal) {
                this._scrollView.yAlign = dockManager.settings.alwaysCenterIcons
                    ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
            } else {
                this._scrollView.xAlign = dockManager.settings.alwaysCenterIcons
                    ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
            }
        }

        if (settings.isolateWorkspaces ||
            settings.isolateMonitors) {
            // When using isolation, we filter out apps that have no windows in
            // the current workspace
            const monitorIndex = this._monitorIndex;
            running = running.filter(app =>
                AppIcons.getInterestingWindows(app.get_windows(), monitorIndex).length);
        }

        const children = this._box.get_children().filter(actor => {
            return actor.child &&
                   actor.child._delegate &&
                   actor.child._delegate.app;
        });
        // Apps currently in the dash
        let oldApps = children.map(actor => actor.child._delegate.app);
        // Apps supposed to be in the dash
        const newApps = [];

        const {showFavorites} = settings;
        if (showFavorites)
            newApps.push(...Object.values(favorites));

        if (settings.showRunning) {
            // We reorder the running apps so that they don't change position on the
            // dash with every redisplay() call

            // First: add the apps from the oldApps list that are still running
            oldApps.forEach(oldApp => {
                const index = running.indexOf(oldApp);
                if (index > -1) {
                    const [app] = running.splice(index, 1);
                    if (!showFavorites || !(app.get_id() in favorites))
                        newApps.push(app);
                }
            });

            // Second: add the new apps
            running.forEach(app => {
                if (!showFavorites || !(app.get_id() in favorites))
                    newApps.push(app);
            });
        }

        this._signalsHandler.removeWithLabel(Labels.SHOW_MOUNTS);
        if (dockManager.removables) {
            this._signalsHandler.addWithLabel(Labels.SHOW_MOUNTS,
                dockManager.removables, 'changed', this._queueRedisplay.bind(this));
            dockManager.removables.getApps().forEach(removable => {
                if (!newApps.includes(removable))
                    newApps.push(removable);
            });
        } else {
            oldApps = oldApps.filter(app => !app.location || app.isTrash || app.isDownloads);
        }

        if (dockManager.downloads) {
            const downloadsApp = dockManager.downloads.getApp();
            if (!newApps.includes(downloadsApp))
                newApps.push(downloadsApp);
        } else {
            oldApps = oldApps.filter(app => !app.isDownloads);
        }

        if (dockManager.trash) {
            const trashApp = dockManager.trash.getApp();
            if (!newApps.includes(trashApp))
                newApps.push(trashApp);
        } else {
            oldApps = oldApps.filter(app => !app.isTrash);
        }

        // Temporary remove the separator so that we don't compute to position icons
        const oldSeparatorPos = this._box.get_children().indexOf(this._separator);
        if (this._separator)
            this._box.remove_child(this._separator);

        // Figure out the actual changes to the list of items; we iterate
        // over both the list of items currently in the dash and the list
        // of items expected there, and collect additions and removals.
        // Moves are both an addition and a removal, where the order of
        // the operations depends on whether we encounter the position
        // where the item has been added first or the one from where it
        // was removed.
        // There is an assumption that only one item is moved at a given
        // time; when moving several items at once, everything will still
        // end up at the right position, but there might be additional
        // additions/removals (e.g. it might remove all the launchers
        // and add them back in the new order even if a smaller set of
        // additions and removals is possible).
        // If above assumptions turns out to be a problem, we might need
        // to use a more sophisticated algorithm, e.g. Longest Common
        // Subsequence as used by diff.

        const addedItems = [];
        const removedActors = [];

        let newIndex = 0;
        let oldIndex = 0;
        while (newIndex < newApps.length || oldIndex < oldApps.length) {
            const oldApp = oldApps.length > oldIndex ? oldApps[oldIndex] : null;
            const newApp = newApps.length > newIndex ? newApps[newIndex] : null;

            // No change at oldIndex/newIndex
            if (oldApp === newApp) {
                oldIndex++;
                newIndex++;
                continue;
            }

            // App removed at oldIndex
            if (oldApp && !newApps.includes(oldApp)) {
                removedActors.push(children[oldIndex]);
                oldIndex++;
                continue;
            }

            // App added at newIndex
            if (newApp && !oldApps.includes(newApp)) {
                addedItems.push({
                    app: newApp,
                    item: this._createAppItem(newApp),
                    pos: newIndex,
                });
                newIndex++;
                continue;
            }

            // App moved
            const nextApp = newApps.length > newIndex + 1
                ? newApps[newIndex + 1] : null;
            const insertHere = nextApp && nextApp === oldApp;
            const alreadyRemoved = removedActors.reduce((result, actor) => {
                const removedApp = actor.child._delegate.app;
                return result || removedApp === newApp;
            }, false);

            if (insertHere || alreadyRemoved) {
                const newItem = this._createAppItem(newApp);
                addedItems.push({
                    app: newApp,
                    item: newItem,
                    pos: newIndex + removedActors.length,
                });
                newIndex++;
            } else {
                removedActors.push(children[oldIndex]);
                oldIndex++;
            }
        }

        for (let i = 0; i < addedItems.length; i++) {
            this._box.insert_child_at_index(addedItems[i].item,
                addedItems[i].pos);
        }

        for (let i = 0; i < removedActors.length; i++) {
            const item = removedActors[i];

            // The magnification map is keyed by the AppIcon (actor.child),
            // not by the DashItemContainer delegate: look clones up with
            // item.child, otherwise the orphan cleanup never fires.
            const icon = item.child;

            if (icon) {
                // The item is leaving the dock; if a magnified clone of it
                // was floating in Main.uiGroup, destroy it now — otherwise
                // it stays behind as an orphan duplicate while the rebuilt
                // icon shows its (visible) real widget below the floating
                // clone.
                const orphan = this._pulsarMagnificationClones?.get(icon);
                if (orphan) {
                    orphan.destroy();
                    this._pulsarMagnificationClones.delete(icon);
                    icon._pulsarMagnifyClone = null;
                }
            }

            // Don't animate item removal when the overview is transitioning
            // or hidden
            if (!Main.overview.animationInProgress)
                item.animateOutAndDestroy();
            else
                item.destroy();
        }

        // Update separator
        const nFavorites = Object.keys(favorites).length;
        const nIcons = children.length + addedItems.length - removedActors.length;
        if (nFavorites > 0 && nFavorites < nIcons) {
            if (!this._separator) {
                this._separator = new St.Widget({
                    style_class: 'dash-separator',
                    x_align: this._isHorizontal
                        ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
                    y_align: this._isHorizontal
                        ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
                    width: this._isHorizontal ? -1 : this.iconSize,
                    height: this._isHorizontal ? this.iconSize : -1,
                    reactive: true,
                    track_hover: true,
                });
                this._separator.connect('notify::hover', a => this._ensureItemVisibility(a));
            }
            let pos = nFavorites + this._animatingPlaceholdersCount;
            if (this._dragPlaceholder)
                pos++;
            const removedFavorites = removedActors.filter(a =>
                children.indexOf(a) < oldSeparatorPos);
            pos += removedFavorites.length;
            this._box.insert_child_at_index(this._separator, pos);
        } else if (this._separator) {
            this._separator.destroy();
            this._separator = null;
        }

        this._adjustIconSize();

        // Skip animations on first run when adding the initial set
        // of items, to avoid all items zooming in at once
        const animate = this._shownInitially &&
            !Main.layoutManager._startingUp;

        if (!this._shownInitially)
            this._shownInitially = true;

        addedItems.forEach(({item}) => item.show(animate));

        // Workaround for https://bugzilla.gnome.org/show_bug.cgi?id=692744
        // Without it, StBoxLayout may use a stale size cache
        this._box.queue_relayout();

        // This will update the size, and the corresponding number for each icon
        this._updateNumberOverlay();

        // Update Minimized Windows Section
        if (this._minimizedSeparator) {
            this._box.remove_child(this._minimizedSeparator);
            this._minimizedSeparator.destroy();
            this._minimizedSeparator = null;
        }
        if (this._minimizedWindowItems) {
            this._minimizedWindowItems.forEach(item => {
                this._box.remove_child(item);
                item.destroy();
            });
            this._minimizedWindowItems = [];
        }

        if (Docking.DockManager.settings.showMinimizedWindows) {
            const currentWorkspace = global.workspace_manager.get_active_workspace();
            const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, currentWorkspace);
            const minimizedWindows = allWindows.filter(w => w.minimized && !w.skip_taskbar);

            if (minimizedWindows.length > 0) {
                this._minimizedSeparator = new St.Widget({
                    style_class: 'dash-separator',
                    x_align: this._isHorizontal
                        ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
                    y_align: this._isHorizontal
                        ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
                    width: this._isHorizontal ? -1 : this.iconSize,
                    height: this._isHorizontal ? this.iconSize : -1,
                    reactive: true,
                    track_hover: true,
                });
                this._box.add_child(this._minimizedSeparator);

                this._minimizedWindowItems = [];
                minimizedWindows.forEach(win => {
                    const item = new DockMinimizedWindowItem(win, this.iconSize, this._isHorizontal);
                    this._box.add_child(item);
                    this._minimizedWindowItems.push(item);
                });
            }
        }

        // The icon list just changed: re-apply the magnification with the
        // last known pointer pose, so freshly built icons are covered by
        // their clones (and their real widgets hidden) even without pointer
        // motion.
        this._pulsarReapplyMagnification();

        this.updateShowAppsButton();
    }

    _updateNumberOverlay() {
        const appIcons = this.getAppIcons();
        let counter = 1;
        appIcons.forEach(icon => {
            // PulsarOS: getAppIcons() also yields non-app items
            // (Downloads/Trash tiles, the minimized-window preview, the
            // Show Apps button); only DockAbstractAppIcon has the number
            // overlay API. Skip the rest instead of throwing a TypeError
            // on every redisplay.
            if (!icon.setNumberOverlay)
                return;
            if (counter < 10) {
                icon.setNumberOverlay(counter);
                counter++;
            } else if (counter === 10) {
                icon.setNumberOverlay(0);
                counter++;
            } else {
                // No overlay after 10
                icon.setNumberOverlay(-1);
            }
            icon.updateNumberOverlay();
        });
    }

    toggleNumberOverlay(activate) {
        const appIcons = this.getAppIcons();
        appIcons.forEach(icon => {
            if (!icon.toggleNumberOverlay)
                return;
            icon.toggleNumberOverlay(activate);
        });
    }

    _initializeIconSize(maxSize) {
        const maxAllowed = baseIconSizes[baseIconSizes.length - 1];
        maxSize = Math.min(maxSize, maxAllowed);

        if (Docking.DockManager.settings.iconSizeFixed) {
            this._availableIconSizes = [maxSize];
        } else {
            this._availableIconSizes = baseIconSizes.filter(val => {
                return val < maxSize;
            });
            this._availableIconSizes.push(maxSize);
        }
    }

    setIconSize(maxSize, doNotAnimate) {
        this._initializeIconSize(maxSize);

        if (doNotAnimate)
            this._shownInitially = false;

        this._queueRedisplay();
    }

    /**
     * Reset the displayed apps icon to maintain the correct order when changing
     * show favorites/show running settings
     */
    resetAppIcons() {
        const children = this._box.get_children().filter(actor => {
            return actor.child &&
                   !!actor.child.icon;
        });
        for (let i = 0; i < children.length; i++) {
            const item = children[i];
            item.destroy();
        }

        // to avoid ugly animations, just suppress them like when dash is first loaded.
        this._shownInitially = false;
        this._redisplay();
    }

    get showAppsButton() {
        return this._showAppsIcon.toggleButton;
    }

    showShowAppsButton() {
        this._showAppsIcon.visible = true;
        this._showAppsIcon.show(true);
        this.updateShowAppsButton();
    }

    hideShowAppsButton() {
        this._showAppsIcon.visible = false;
    }

    get maxWidth() {
        return this._maxWidth;
    }

    get maxHeight() {
        return this._maxHeight;
    }

    set maxWidth(maxWidth) {
        this.setMaxSize(maxWidth, this._maxHeight);
    }

    set maxHeight(maxHeight) {
        this.setMaxSize(this._maxWidth, maxHeight);
    }

    setMaxSize(maxWidth, maxHeight) {
        if (this._maxWidth === maxWidth &&
            this._maxHeight === maxHeight)
            return;

        this._maxWidth = maxWidth;
        this._maxHeight = maxHeight;
        this._queueRedisplay();
    }

    updateShowAppsButton() {
        if (this._showAppsIcon.get_parent() && !this._showAppsIcon.visible)
            return;

        const {settings} = Docking.DockManager;
        const notifiedProperties = [];
        const showAppsContainer = settings.showAppsAlwaysInTheEdge || !settings.dockExtended
            ? this._dashContainer : this._boxContainer;
        const needsFirstLastChildWorkaround = Config.PACKAGE_VERSION.split('.')[0] < 49;

        if (needsFirstLastChildWorkaround) {
            this._signalsHandler.addWithLabel(Labels.FIRST_LAST_CHILD_WORKAROUND,
                showAppsContainer, 'notify',
                (_obj, pspec) => notifiedProperties.push(pspec.name));
        }

        if (this._showAppsIcon.get_parent() !== showAppsContainer) {
            this._showAppsIcon.get_parent()?.remove_child(this._showAppsIcon);

            if (Docking.DockManager.settings.showAppsAtTop)
                showAppsContainer.insert_child_below(this._showAppsIcon, null);
            else
                showAppsContainer.insert_child_above(this._showAppsIcon, null);
        } else if (settings.showAppsAtTop) {
            showAppsContainer.set_child_below_sibling(this._showAppsIcon, null);
        } else {
            showAppsContainer.set_child_above_sibling(this._showAppsIcon, null);
        }

        if (needsFirstLastChildWorkaround) {
            this._signalsHandler.removeWithLabel(Labels.FIRST_LAST_CHILD_WORKAROUND);

            // This is indeed ugly, but we need to ensure that the last and first
            // visible widgets are re-computed by St, that is buggy because of a
            // mutter issue that is being fixed:
            // https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/2047
            if (!notifiedProperties.includes('first-child'))
                showAppsContainer.notify('first-child');
            if (!notifiedProperties.includes('last-child'))
                showAppsContainer.notify('last-child');
        }
    }
});


/**
 * This is a copy of the same function in utils.js, but also adjust horizontal scrolling
 * and perform few further checks on the current value to avoid changing the values when
 * it would be clamp to the current one in any case.
 * Return the amount of shift applied
 *
 * @param scrollView
 * @param actor
 */
function ensureActorVisibleInScrollView(scrollView, actor) {
    // access to scrollView.[hv]scroll was deprecated in gnome 46
    // instead, adjustment can be accessed directly
    // keep old way for backwards compatibility (gnome <= 45)
    const vAdjustment = scrollView.vadjustment ?? scrollView.vscroll.adjustment;
    const hAdjustment = scrollView.hadjustment ?? scrollView.hscroll.adjustment;
    const {value: vValue0, pageSize: vPageSize, upper: vUpper} = vAdjustment;
    const {value: hValue0, pageSize: hPageSize, upper: hUpper} = hAdjustment;
    let [hValue, vValue] = [hValue0, vValue0];
    let vOffset = 0;
    let hOffset = 0;

    const fade = scrollView.get_effect('fade');
    if (fade) {
        vOffset = fade.fade_margins.top;
        hOffset = fade.fade_margins.left;
    }

    const box = actor.get_allocation_box();
    let {y1} = box, {y2} = box, {x1} = box, {x2} = box;

    let parent = actor.get_parent();
    while (parent !== scrollView) {
        if (!parent)
            throw new Error('Actor not in scroll view');

        const parentBox = parent.get_allocation_box();
        y1 += parentBox.y1;
        y2 += parentBox.y1;
        x1 += parentBox.x1;
        x2 += parentBox.x1;
        parent = parent.get_parent();
    }

    if (y1 < vValue + vOffset)
        vValue = Math.max(0, y1 - vOffset);
    else if (vValue < vUpper - vPageSize && y2 > vValue + vPageSize - vOffset)
        vValue = Math.min(vUpper - vPageSize, y2 + vOffset - vPageSize);

    if (x1 < hValue + hOffset)
        hValue = Math.max(0, x1 - hOffset);
    else if (hValue < hUpper - hPageSize && x2 > hValue + hPageSize - hOffset)
        hValue = Math.min(hUpper - hPageSize, x2 + hOffset - hPageSize);

    if (vValue !== vValue0) {
        vAdjustment.ease(vValue, {
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            duration: Util.SCROLL_TIME,
        });
    }

    if (hValue !== hValue0) {
        hAdjustment.ease(hValue, {
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            duration: Util.SCROLL_TIME,
        });
    }

    return [hValue - hValue0, vValue - vValue0];
}
