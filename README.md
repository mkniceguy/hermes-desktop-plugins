# hermes-desktop-plugins

Hermes Desktop plugins for [Hermes Agent](https://hermes-agent.nousresearch.com/).

## Plugins

### ytm-control
Controls [YouTube Music Desktop App](https://ytmdesktop.app/) via its Companion
Server / Socket.IO. Right-side pane with now-playing (thumbnail/title/artist/album),
seek slider, SVG transport controls (prev / play-pause / next), shuffle + repeat,
like/dislike pill with live status, volume slider, collapsible queue, playlist
browser, and a statusbar mini-chip (play/pause + track title) for quick control
with the pane closed. One-time auth flow; token and Companion Server URL persist in
plugin-local storage. v0.4 adds a unified Hermes plugin (desktop + backend), queue
+ playlist controls, and realtime updates through the backend Socket.IO bridge.

## Installation

### Flat desktop plugin (portable fallback)

Copy just the frontend plugin:
```
~/.hermes/desktop-plugins/<plugin-name>/plugin.js
```

The app watches that directory and hot-reloads on save. If it doesn't appear:
**Ctrl+K** → "Reload desktop plugins".

### Unified Hermes plugin (backend + realtime)

For the full unified build, copy the whole plugin directory to your profile:
```
~/.hermes/plugins/<plugin-name>/
  desktop/plugin.js
  dashboard/manifest.json
  dashboard/plugin_api.py
  requirements.txt
```
Then enable it in `config.yaml`:
```yaml
plugins:
  enabled:
    - ytm-control
```
Restart Hermes after enabling. Backend dependencies are listed in `requirements.txt`.

- **ytm-control**: Click "Connect to YouTube Music" in the pane and approve the
  popup in YTMDesktop (Settings → Integrations → Companion Server must be
  enabled). Open ⚙ in the pane to point at a non-default Companion Server URL.
