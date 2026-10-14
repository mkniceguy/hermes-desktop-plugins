#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${HERMES_PROFILE:-jarvis}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
BASE="$HERMES_HOME/profiles/$PROFILE"
PLUGIN_DIR="$BASE/plugins/ytm-control"

echo "Installing ytm-control v0.4.0 for profile '$PROFILE'..."
echo "HERMES_HOME=$HERMES_HOME"

mkdir -p "$PLUGIN_DIR/desktop" "$PLUGIN_DIR/dashboard"
cp "$SRC_DIR/plugin.js" "$PLUGIN_DIR/desktop/plugin.js"
cp "$SRC_DIR/dashboard/manifest.json" "$PLUGIN_DIR/dashboard/manifest.json"
cp "$SRC_DIR/dashboard/plugin_api.py" "$PLUGIN_DIR/dashboard/plugin_api.py"
cp "$SRC_DIR/requirements.txt" "$PLUGIN_DIR/requirements.txt" 2>/dev/null || true

# also keep a disk-plugin copy for fallback/debug use
mkdir -p "$HERMES_HOME/desktop-plugins/ytm-control"
cp "$SRC_DIR/plugin.js" "$HERMES_HOME/desktop-plugins/ytm-control/plugin.js"

# enable the plugin in config.yaml
python3 - "$BASE/config.yaml" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
if "  - ytm-control" not in text:
    text = text.replace("plugins:\n  enabled:\n", "plugins:\n  enabled:\n    - ytm-control\n", 1)
    open(path, "w").write(text)
    print("enabled ytm-control in", path)
else:
    print("ytm-control already enabled")
PY

echo
echo "Done. Installed to:"
echo "  $PLUGIN_DIR"
echo
echo "Next: restart Hermes (gateway/serve) and enable the plugin in Capabilities -> Plugins."
