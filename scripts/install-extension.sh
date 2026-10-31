#!/usr/bin/env bash
# Install the GNOME Shell extension for the current user.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="rgb-keyboard@avell"
SRC="$ROOT/extension/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if [[ ! -d "$SRC" ]]; then
  echo "Extension source not found: $SRC" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -a "$SRC/." "$DEST/"

glib-compile-schemas "$DEST/schemas"

echo "Installed to $DEST"
echo
echo "Enable with:"
echo "  gnome-extensions enable $UUID"
echo
echo "On Wayland you must log out/in (or restart GNOME Shell) after enabling."
echo "On X11 you can press Alt+F2, type r, Enter."

# Prefer gsettings so the UUID is enabled after the next Shell start,
# even if the running session has not rescanned extensions yet.
if command -v gsettings >/dev/null && gsettings list-keys org.gnome.shell 2>/dev/null | grep -qx enabled-extensions; then
  python3 - <<'PY'
import subprocess, ast, os
uuid = "rgb-keyboard@avell"
raw = subprocess.check_output(["gsettings", "get", "org.gnome.shell", "enabled-extensions"], text=True).strip()
enabled = ast.literal_eval(raw) if raw not in ("@as []", "[]") else []
if uuid not in enabled:
    enabled.append(uuid)
    out = "[" + ", ".join(f"'{u}'" for u in enabled) + "]"
    subprocess.check_call(["gsettings", "set", "org.gnome.shell", "enabled-extensions", out])
    print(f"Added {uuid} to enabled-extensions")
else:
    print(f"{uuid} already in enabled-extensions")
PY
fi

# Best-effort live reload (Wayland may still need logout if Shell cached the module).
if command -v gnome-extensions >/dev/null; then
  gnome-extensions disable "$UUID" 2>/dev/null || true
  sleep 0.4
  gnome-extensions enable "$UUID" 2>/dev/null || true
fi

echo
echo "If the panel icon looks stale on Wayland, log out and back in once."
