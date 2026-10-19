# Pulsar Dock

The **Pulsar Dock** as shipped in **Pulsar OS**: a dock for GNOME Shell
customised by Inled Pulsar OS with macOS-style hover magnification, launch
bounce animations, a Downloads stack and live previews of minimised windows.
Version 106, UUID `pulsar-dock@inled.es`, GNOME Shell 45–51.

## Provenance and licence

Pulsar Dock is a fork of [micheleg/dash-to-dock](https://github.com/micheleg/dash-to-dock),
which is licensed under the **GNU General Public License, version 2 or later** —
see [`COPYING`](COPYING). The upstream project and its authors are the work of
the original developers; Pulsar OS builds on it and thanks them for releasing it
under the GPL.

The upstream README is preserved below this section.

## What Pulsar Dock changes

* **macOS-style hover magnification** — exponential zoom (`ZOOM 2.0`,
  `EXTENT 7`) with a per-icon magnification pass in `dash.js`, a perpendicular
  hover band measured from the real icon actors (`PERP_ENTER` / `PERP_LEAVE`)
  and leave hysteresis, so the edge icons stay reachable.
* **Launch bounce** with a settle animation and a pinned-icon grace period, in
  `appIcons.js`.
* **Live window previews** and a **Downloads stack** on the dock.
* **Overflow easing** on the dock container, with a launch freeze pose so
  icons do not jump while an app is starting.
* **Liquid Glass integration** — the dock can be rendered with the
  [Liquid Glass](https://github.com/ryohsuke1231/liquid-glass) edge lens,
  driven by the `dock-glass-*` keys of the schema.
* No "show applications" button; macOS-style layout and spacing.

### Pulsar constants (`dash.js`)

| Constant | Value | Meaning |
| --- | --- | --- |
| `ZOOM` | 2.0 | Magnification factor |
| `EXTENT` | 7 | Icons affected on each side of the hovered one |
| `SETTLE_MS` | 80 | Settle animation duration |
| `LAUNCH_PIN_MS` | 10000 | How long a launching icon is pinned |
| `LEAVE_MARGIN` | 32 | Leave hysteresis in px |
| `PERP_ENTER` / `PERP_LEAVE` | 2 / 4 | Perpendicular hover band thresholds |

## Installation

```sh
git clone https://github.com/Agnell02010/Pulsar-Dock.git
cd Pulsar-Dock
./install.sh
```

`install.sh` copies the extension into
`~/.local/share/gnome-shell/extensions/pulsar-dock@inled.es`, compiles the
GSettings schema and enables it. It reads the UUID from `metadata.json`, so it
is safe to re-run and does not depend on the folder's name.

Manual install, if you prefer:

```sh
mkdir -p ~/.local/share/gnome-shell/extensions/pulsar-dock@inled.es
cp -r . ~/.local/share/gnome-shell/extensions/pulsar-dock@inled.es/
gnome-extensions enable pulsar-dock@inled.es
```

On Wayland, log out and back in after installing or replacing the extension.

---

# Upstream README: Dash to Dock

![screenshot](https://github.com/micheleg/dash-to-dock/raw/master/media/screenshot.jpg)

## A dock for the GNOME Shell
This extension enhances the dash moving it out of the overview and transforming it in a dock for an easier launching of applications and a faster switching between windows and desktops without having to leave the desktop view.

[<img src="https://micheleg.github.io/dash-to-dock/media/get-it-on-ego.png" height="100">](https://extensions.gnome.org/extension/307/dash-to-dock)

For additional installation instructions and more information visit [https://micheleg.github.io/dash-to-dock/](https://micheleg.github.io/dash-to-dock/).

## Installation from source

The extension can be installed directly from source, either for the convenience of using git or to test the latest development version. Clone the desired branch with git

### Build Dependencies

To compile the stylesheet you'll need an implementation of SASS. Dash to Dock supports `dart-sass` (`sass`), `sassc`, and `ruby-sass`. Every distro should have at least one of these implementations, we recommend using `dart-sass` (`sass`) or `sassc` over `ruby-sass` as `ruby-sass` is deprecated.

By default, Dash to Dock will attempt to build with `sassc`. To change this behavior set the `SASS` environment variable to either `dart` or `ruby`.

```bash
export SASS=dart
# or...
export SASS=ruby
```

### Building

Clone the repository or download the branch from github. A simple Makefile is included.

Next use `make` to install the extension into your home directory. A Shell reload is required <kbd>Alt</kbd> + <kbd>F2</kbd> <kbd>r</kbd> <kbd>Enter</kbd> under Xorg or under Wayland you may have to logout and login. The extension has to be enabled  with *gnome-extensions-app* (GNOME Extensions) or with *dconf*.

```bash
git clone https://github.com/micheleg/dash-to-dock.git
make -C dash-to-dock install
```

If `msgfmt` is not available on your system, you will see an error message like the following:

```bash
make: msgfmt: No such file or directory
```

In this case install the `gettext` package from your distribution's repository.


## Bug Reporting

Bugs should be reported to the Github bug tracker [https://github.com/micheleg/dash-to-dock/issues](https://github.com/micheleg/dash-to-dock/issues).

## License
Dash to Dock Gnome Shell extension is distributed under the terms of the GNU General Public License,
version 2 or later. See the COPYING file for details.
