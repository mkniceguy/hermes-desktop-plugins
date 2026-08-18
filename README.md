# hermes-desktop-plugins

Hermes Desktop plugins for [Hermes Agent](https://hermes-agent.nousresearch.com/).

## Plugins

### plex-status
Plex activity pane backed by [Tautulli](https://tautulli.com/): active streams with per-session details (user, title, state, progress, quality), total bandwidth, **transcode detection** (amber header dot + per-row badge showing which legs are transcoding), and a **recently added** strip. Polls `get_activity` every 15s.

Config is stored in plugin-local storage via an in-pane settings form (⚙ in the header) — URL + API key are validated against Tautulli before saving. Nothing secret lives in `plugin.js`.

### ytm-control
Controls [YouTube Music Desktop App](https://ytmdesktop.app/) via its Companion Server API. Right-side pane with now-playing (thumbnail/title/artist/album), **seek slider**, SVG transport controls (prev / play-pause / next), **like/dislike pill** with live status, and a volume slider. Plus a **statusbar mini-chip** (play/pause + track title) for quick control with the pane closed. One-time auth flow; token persists in plugin-local storage. Disconnect button in the pane header.

## Installation

Copy the plugin folder(s) to your Hermes desktop-plugins directory:
```
~/.hermes/desktop-plugins/<plugin-name>/plugin.js
```

The app watches that directory and hot-reloads on save. If it doesn't appear: **Ctrl+K** → "Reload desktop plugins".

## Configuration

- **plex-status**: Enter Tautulli URL + API key in the pane's settings form (⚙). Key is in Tautulli → Settings → Web Interface → API Key.
- **ytm-control**: Click "Connect to YouTube Music" in the pane and approve the popup in YTMDesktop (Settings → Integrations → Companion Server must be enabled).
