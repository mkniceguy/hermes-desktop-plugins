# hermes-desktop-plugins

Hermes Desktop plugins for [Hermes Agent](https://hermes-agent.nousresearch.com/).

## Plugins

### ytm-control
Controls [YouTube Music Desktop App](https://ytmdesktop.app/) via its Companion
Server API. Right-side pane with now-playing (thumbnail/title/artist/album),
seek slider, SVG transport controls (prev / play-pause / next), like/dislike
pill with live status, volume slider, and a statusbar mini-chip (play/pause +
track title) for quick control with the pane closed. One-time auth flow; token
and Companion Server URL persist in plugin-local storage. v0.2 adds a settings
form (save & test), offline/error states, approval-polling auth, and debounced seek.

## Installation

Copy the plugin folder to your Hermes desktop-plugins directory:
```
~/.hermes/desktop-plugins/<plugin-name>/plugin.js
```

The app watches that directory and hot-reloads on save. If it doesn't appear:
**Ctrl+K** → "Reload desktop plugins".

## Configuration

- **ytm-control**: Click "Connect to YouTube Music" in the pane and approve the
  popup in YTMDesktop (Settings → Integrations → Companion Server must be
  enabled). Open ⚙ in the pane to point at a non-default Companion Server URL.
