# hermes-desktop-plugins

Hermes Desktop plugins for [Hermes Agent](https://hermes-agent.nousresearch.com/).

## Plugins

### plex-status
Shows active Plex streaming status — stream count, bandwidth, per-session details (user, title, state, progress, quality). Polls [Tautulli](https://tautulli.com/) every 15 seconds.

### ytm-control
Controls [YouTube Music Desktop App](https://ytmdesktop.app/) — now playing display, playback controls (play/pause, next, previous), volume slider, and like/dislike. Connects via the Companion Server API.

## Installation

Copy the plugin folder(s) to your Hermes desktop-plugins directory:
```
~/.hermes/desktop-plugins/<plugin-name>/plugin.js
```

Then reload in the Hermes Desktop app: **Ctrl+K** → "Reload desktop plugins".

## Configuration

Each plugin has configuration constants at the top of its `plugin.js` file:
- **plex-status**: Set `TAUTULLI_URL` and `TAUTULLI_API_KEY`
- **ytm-control**: No configuration needed — connects via one-time auth flow
