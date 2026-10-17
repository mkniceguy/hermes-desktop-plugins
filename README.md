# hermes-desktop-plugins

Hermes Desktop plugins for [Hermes Agent](https://hermes-agent.nousresearch.com/).

## Plugins

### ytm-control

Controls the [YouTube Music Desktop App](https://ytmdesktop.app/) through its
Companion Server API. Right-side pane with now-playing (thumbnail/title/artist/album),
seek slider, SVG transport controls (prev / play-pause / next), shuffle + repeat,
like/dislike pill with live status, volume slider, collapsible queue, playlist
browser, and a statusbar mini-chip (play/pause + track title) for quick control
with the pane closed.

## Architecture (v0.4.1)

One plugin folder, two halves, **one data path**:

```
ytm-control/
├── pyproject.toml          # dependency declaration — load-bearing, see below
├── dashboard/
│   ├── manifest.json       # {"name": "ytm-control", "api": "plugin_api.py"}
│   └── plugin_api.py       # the backend: owns auth, Socket.IO, all HTTP to the server
└── desktop/
    └── plugin.js           # the UI: ctx.rest + host.onEvent only
```

The **backend is the single source of truth**. It holds the Companion Server URL and
the auth token, validates addresses, and owns the Socket.IO connection. The desktop
half is presentation only — it calls `/api/plugins/ytm-control/…` via `ctx.rest` and
receives live updates via `host.onEvent('plugin.ytm-control.state.updated')`. It never
contacts the Companion Server directly, which is what makes the private-LAN guard
enforceable.

> **v0.4.1 fixed a real outage.** v0.4 declared no dependencies, so Hermes never
> installed `python-socketio`/`httpx` into its own environment, and the plugin's backend
> died with `No module named 'socketio'` on every startup. v0.4.1 also removed a second,
> parallel `fetch`-based data path that made most backend routes dead code, and fixed a
> hardcoded `~/.hermes` config path that ignored the active profile.

### Why `pyproject.toml` matters

Hermes' package manager reads a plugin's dependencies from exactly three places:
`plugin.yaml` / `plugin.yml` (`pip_dependencies`), `plugin.json`, or `pyproject.toml`
(`[project].dependencies`). **It does not read `requirements.txt`.**

Only a *declared* plugin joins the dependency workspace, and only workspace members get
their specs installed into Hermes' committed environment venv and re-installed on every
update. Do not `pip install` these by hand — a manual install into the wrong interpreter
is exactly what broke v0.4.

There is deliberately no `[build-system]` table, which marks this as a metadata-only
workspace member (nothing is built from it).

## Installation

Copy the **whole folder** — the halves are one installable unit:

```bash
./ytm-control/install.sh
# or
cp -R ytm-control ~/.hermes/plugins/ytm-control
```

Then enable the backend in `config.yaml` (it is gated on this allow-list, which is a
deliberate security boundary — desktop-side enablement alone does not import Python):

```yaml
plugins:
  enabled:
    - ytm-control
```

Restart Hermes. On startup Hermes installs the declared dependencies and copies
`desktop/plugin.js` into `<root>/desktop-plugins/ytm-control/` — the app loads that
copy, not your package. If the pane does not appear: **Ctrl+K** → "Reload desktop
plugins", or **Capabilities → Plugins → Rescan**.

Developing? Symlink a checkout into `plugins/` so every save hot-reloads, and run
`hermes plugins doctor ytm-control` to catch a stale desktop copy.

## Using it

Click **Connect to YouTube Music** in the pane. A code appears; approve the request
inside YT Music Desktop (the Companion Server must be enabled under
**Settings → Integrations → Companion Server**). The token is stored by the backend
and persists across restarts.

Open the ⚙ in the pane to point at a non-default Companion Server. Addresses are
restricted to localhost and private LAN ranges; `localhost` is normalised to
`127.0.0.1` because the Companion Server does not listen on IPv6.
