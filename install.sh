#!/usr/bin/env bash
#
# Pulsar Dock - installer
# Copyright (C) 2026 Inled Pulsar OS
# License: GPL-2.0-or-later (see COPYING)
#
# Usage:  ./install.sh
#
# Copies this folder into ~/.local/share/gnome-shell/extensions/<uuid>,
# compiles the GSettings schema if needed and enables the extension.
# Safe to re-run: it replaces a previous install.
#
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; C=""; N=""; fi
ok()   { echo "${G}  ok${N}  $*"; }
warn() { echo "${Y}  !!${N}  $*"; }
err()  { echo "${R}  xx${N}  $*" >&2; }
info() { echo "${C}  ..${N}  $*"; }

echo
echo "${B}Pulsar Dock - installer${N}"
echo "-----------------------------------------------"
echo

# ----------------------------------------------------------- sanity checks
if ! command -v gnome-extensions >/dev/null 2>&1; then
  err "'gnome-extensions' not found: this does not look like GNOME Shell."
  exit 1
fi

if [ ! -f "$SRC_DIR/metadata.json" ]; then
  err "metadata.json not found in $SRC_DIR"
  err "Run this script from the cloned repository folder."
  exit 1
fi

# Read the UUID out of metadata.json without requiring jq.
UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC_DIR/metadata.json" | head -1)"
if [ -z "$UUID" ]; then
  err "Could not read the extension UUID from metadata.json"
  exit 1
fi

EXT_DST="$HOME/.local/share/gnome-shell/extensions/$UUID"

SHELL_VER="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
if [ -n "${SHELL_VER:-}" ]; then
  info "GNOME Shell detected: version $SHELL_VER"
else
  warn "Could not determine the GNOME Shell version."
fi
info "Extension UUID: $UUID"

# ------------------------------------------------------- copy the extension
echo
info "Installing to ${B}$EXT_DST${N}"
mkdir -p "$(dirname "$EXT_DST")"
rm -rf "$EXT_DST"
mkdir -p "$EXT_DST"

# Copy everything except VCS metadata and this script's own junk.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude='.git' --exclude='.github' --exclude='*.shell-extension.zip' \
    "$SRC_DIR"/ "$EXT_DST"/
else
  (cd "$SRC_DIR" && tar -cf - --exclude='.git' --exclude='.github' \
      --exclude='*.shell-extension.zip' .) | (cd "$EXT_DST" && tar -xf -)
fi
ok "Copied ($(find "$EXT_DST" -type f | wc -l) files)"

# --------------------------------------------------------- compile schemas
SCHEMA_DIR="$EXT_DST/schemas"
if [ -d "$SCHEMA_DIR" ] && ls "$SCHEMA_DIR"/*.gschema.xml >/dev/null 2>&1; then
  if command -v glib-compile-schemas >/dev/null 2>&1; then
    if glib-compile-schemas "$SCHEMA_DIR" 2>/dev/null; then
      ok "GSettings schema compiled"
    else
      warn "glib-compile-schemas failed; keeping any pre-built schema."
    fi
  elif [ -f "$SCHEMA_DIR/gschemas.compiled" ]; then
    ok "glib-compile-schemas not found, using the pre-built schema in the repo"
  else
    warn "No compiled schema and no glib-compile-schemas."
    warn "Install glib2 (or glib2-devel) and re-run this script."
  fi
fi

# ---------------------------------------------------------------- enabling
echo
if gnome-extensions enable "$UUID" 2>/dev/null; then
  ok "Extension enabled"
else
  warn "Could not enable it automatically."
  warn "Do it by hand:  gnome-extensions enable $UUID"
fi

# ----------------------------------------------------------------- finish
echo
echo "-----------------------------------------------"
echo "${G}${B}Installation completed!${N}"
echo
echo "  ${B}Now log out and back in (logout/login).${N}"
echo "  On Wayland this is required for GNOME to reload the extension."
echo
echo "  To uninstall:  gnome-extensions disable $UUID && rm -rf \"$EXT_DST\""
echo
