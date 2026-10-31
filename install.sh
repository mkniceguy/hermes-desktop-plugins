#!/usr/bin/env bash
# Install Hermes Desktop plugins from this repository into a Hermes home/profile.
#
# Usage:
#   ./install.sh                           # install all plugins into $HERMES_HOME (or ~/.hermes)
#   ./install.sh ytm-control               # install only ytm-control
#   ./install.sh plex-status               # install only plex-status
#   ./install.sh -p jarvis                 # install all into profile 'jarvis'
#   ./install.sh -p jarvis plex-status     # install plex-status into profile 'jarvis'
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
ALL_PLUGINS=("ytm-control" "plex-status")

# Resolve default Hermes root ($HERMES_HOME -> %LOCALAPPDATA%/hermes on Windows -> ~/.hermes)
if [ -n "${HERMES_HOME:-}" ]; then
  BASE_HOME="$HERMES_HOME"
elif [ -n "${LOCALAPPDATA:-}" ] && [ -d "${LOCALAPPDATA}/hermes" ]; then
  BASE_HOME="${LOCALAPPDATA}/hermes"
else
  BASE_HOME="$HOME/.hermes"
fi

PROFILE=""
TARGETS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--profile)
      PROFILE="${2:?--profile requires a profile name}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      TARGETS+=("$1")
      shift
      ;;
  esac
done

if [ -n "$PROFILE" ]; then
  # Strip trailing /profiles/<x> if BASE_HOME already points inside one
  ROOT_HOME="${BASE_HOME%/profiles/*}"
  TARGET_HOME="$ROOT_HOME/profiles/$PROFILE"
else
  TARGET_HOME="$BASE_HOME"
  ROOT_HOME="${BASE_HOME%/profiles/*}"
fi

if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=("${ALL_PLUGINS[@]}")
fi

echo "Target Hermes home : $TARGET_HOME"
echo "Desktop root home  : $ROOT_HOME"
echo

for plugin in "${TARGETS[@]}"; do
  SRC="$REPO_DIR/$plugin"
  if [ ! -d "$SRC" ]; then
    echo "ERROR: Unknown plugin '$plugin' (expected directory $SRC)" >&2
    exit 1
  fi
  HERMES_HOME="$TARGET_HOME" HERMES_ROOT="$ROOT_HOME" bash "$SRC/install.sh"
  echo "------------------------------------------------------------"
done

echo "All requested plugins installed: ${TARGETS[*]}"
echo
echo "Ensure they are listed under 'plugins.enabled' in $TARGET_HOME/config.yaml:"
echo "  plugins:"
echo "    enabled:"
for plugin in "${TARGETS[@]}"; do
  echo "      - $plugin"
done
echo
echo "Then restart Hermes (or press Ctrl+K -> 'Reload desktop plugins')."
