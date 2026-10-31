# plex-status — Hermes Desktop Plugin (v0.3.0)

Plex activity pane and statusbar mini-chip backed by [Tautulli](https://tautulli.com/):
- **Active streams** with per-session progress bars, client/device name, LAN/WAN location, bitrate, and quality profile
- **LAN vs. WAN bandwidth** breakdown in the header
- **Hardware / Software transcode detection** (`TRANSCODE · HW · video/audio`)
- **Collapsible Recently Added strip** with `MOVIE` / `TV` / `MUSIC` badges, `SxxExx` episode codes, and relative timestamps
- **Statusbar mini-chip** (`Plex 2 · 14.2 Mbps` when streams are active) and **`Ctrl+K` Command Palette** action (`Plex Status: Refresh Activity`)

## Architecture (v0.3.0)

One unified plugin package, two halves, **one data path**:

```
plex-status/
├── pyproject.toml          # dependency declaration (httpx>=0.27)
├── plugin.yaml             # plugin metadata
├── __init__.py             # agent loader entry point
├── dashboard/
│   ├── manifest.json       # {"name": "plex-status", "api": "plugin_api.py"}
│   └── plugin_api.py       # backend: owns URL + API key on disk (0600) and proxies Tautulli
└── desktop/
    └── plugin.js           # UI: ctx.rest + host.onEvent only (never holds API key)
```

The **Python backend (`dashboard/plugin_api.py`) is the single source of truth**:
- Stores the Tautulli URL and API key in `<hermes_home>/plugin-data/plex-status/config.json` (`chmod 0600`). The API key is never returned to the renderer or exposed in browser DevTools URLs.
- Enforces a **Cleartext Guard**: plain `http://` is restricted to `localhost`, RFC1918 private LAN (`10.x`, `172.16-31.x`, `192.168.x`), Tailscale (`100.64-127.x`), and `.local`/`.lan`/`.home.arpa` hosts. Public remote addresses require `https://`.
- Serializes and caches upstream Tautulli `/api/v2` polls so the pane and statusbar chip share a single upstream budget without CORS issues.
- Automatically migrates any legacy `ctx.storage` credentials from v0.1/v0.2 into the backend on first load and wipes `ctx.storage`.

## Installation

Copy the whole plugin folder into `$HERMES_HOME/plugins/`:

```bash
./plex-status/install.sh
# or manually:
cp -R plex-status ~/.hermes/plugins/plex-status
```

Enable the backend in `config.yaml`:

```yaml
plugins:
  enabled:
    - plex-status
```

Restart Hermes (or use **Capabilities → Plugins → Rescan** and **Ctrl+K → Reload desktop plugins**).

## Configuration

Click `⚙` in the pane header and enter:
1. **Tautulli URL** (e.g., `http://192.168.0.3:30047` or your HTTPS reverse-proxy URL)
2. **Tautulli API Key** (*Tautulli → Settings → Web Interface → API Key*)

Click **Save & test** to verify connectivity before saving, or **Forget** to clear stored credentials.
