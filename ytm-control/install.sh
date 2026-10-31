#!/usr/bin/env bash
# Install ytm-control into a Hermes home/profile.
#
# The whole plugin directory is ONE installable unit: the desktop half
# (desktop/plugin.js), the backend half (dashboard/), and the dependency
# declaration (pyproject.toml). Copy it intact — never split the halves apart.
#
# Usage:
#   ./install.sh                 # install into $HERMES_HOME (or ~/.hermes)
#   HERMES_HOME=~/.hermes/profiles/jarvis ./install.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${HERMES_HOME:-}" ]; then
  TARGET_HOME="$HERMES_HOME"
elif [ -n "${LOCALAPPDATA:-}" ] && [ -d "${LOCALAPPDATA}/hermes" ]; then
  TARGET_HOME="${LOCALAPPDATA}/hermes"
else
  TARGET_HOME="$HOME/.hermes"
fi
ROOT_HOME="${HERMES_ROOT:-${TARGET_HOME%/profiles/*}}"
DEST="$TARGET_HOME/plugins/ytm-control"
DESKTOP_DEST="$ROOT_HOME/desktop-plugins/ytm-control"

echo "Installing ytm-control into:"
echo "  Backend : $DEST"
echo "  Desktop : $DESKTOP_DEST"
echo

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
rm -f "$DEST/install.sh"

mkdir -p "$DESKTOP_DEST"
cp "$SRC/desktop/plugin.js" "$DESKTOP_DEST/plugin.js"

echo "Done."
echo
echo "Next steps:"
echo "  1. Enable the backend in config.yaml (it is gated on this allow-list):"
echo "       plugins:"
echo "         enabled:"
echo "           - ytm-control"
echo "     (or use the desktop app's Capabilities -> Plugins panel)"
echo "  2. Restart Hermes. On startup Hermes installs the declared dependencies"
echo "     from pyproject.toml and copies desktop/plugin.js into"
echo "     <root>/desktop-plugins/ytm-control/."
echo "  3. If the pane does not appear, use Ctrl+K -> 'Reload desktop plugins'"
echo "     (or Capabilities -> Plugins -> Rescan)."
echo
echo "Do NOT pip-install the dependencies by hand. Hermes derives them from"
echo "pyproject.toml into its own committed environment venv, and a manual"
echo "install into some other interpreter is what broke v0.4."
