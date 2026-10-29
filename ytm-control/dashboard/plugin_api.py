"""ytm-control v0.5.0 — backend bridge for the YouTube Music Desktop Companion Server.

This backend is the *single source of truth* for the plugin. It owns:

  * the persisted connection config and the auth token,
  * the Socket.IO connection to the Companion Server (``/api/v1/realtime``),
  * every outbound HTTP call to the Companion Server.

The desktop half only ever talks to this namespace — ``/api/plugins/ytm-control/``
— through ``ctx.rest`` / ``host.onEvent``. It never contacts the Companion Server
directly, which is what makes the private-LAN guard below actually enforceable
(in v0.4 the renderer fetched the Companion Server itself and bypassed it).

Two deliberate robustness choices:

  * ``import socketio`` is **lazy**. In v0.4 a module-level ``import socketio``
    meant that a single missing dependency killed *every* route on this plugin
    (the 2026-10 outage: 8304 x "Failed to load plugin ytm-control API routes:
    No module named 'socketio'"). ``httpx`` is required for the REST proxy;
    ``socketio`` only powers realtime, so a missing ``socketio`` now degrades to
    REST-only instead of taking the whole plugin down.
  * The config directory comes from ``get_hermes_home()``, never a hardcoded
    ``~/.hermes``. v0.4 wrote to ``~/.hermes/plugin-data/`` even while the
    running profile was ``profiles/jarvis``, so the plugin read a stale
    placeholder config belonging to nobody.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import stat
import time
from typing import Any, Dict, Literal, Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

PLUGIN_ID = "ytm-control"
VERSION = "0.5.0"

APP_NAME = "Hermes Desktop"
DEFAULT_BASE_URL = "http://127.0.0.1:9863"
DEFAULT_APP_ID = "hermesdesktop01"

# The realtime API is a Socket.IO **namespace**, not a URL path.
#
# The Companion Server deliberately disconnects anything that lands on the
# default namespace: see ytmdesktop/src/main/integrations/companion-server/
# index.ts — `io.on("connection", socket => socket.disconnect())`. And
# python-socketio does NOT treat a path in the connect URL as a namespace, so
# connecting to ".../api/v1/realtime" silently lands on "/" and is killed.
#
# The namespace must therefore be named explicitly in BOTH places:
#   * ``connect(..., namespaces=[REALTIME_NAMESPACE])``
#   * every handler: ``@sio.on("state-update", namespace=REALTIME_NAMESPACE)``
#
# Getting this wrong produces the worst possible failure mode: the socket
# reports connected=True with a session id and no error, but is silently killed
# and delivers zero events. Upstream issue #1531 documents exactly this
# (maintainer: "The companion server disconnects any connections to the default
# namespace of `/` so that behavior is intentional").
REALTIME_NAMESPACE = "/api/v1/realtime"

# A cached snapshot older than this is not served: the pane would freeze on it
# forever if the socket went quiet. 10 s keeps the worst-case staleness bounded
# while staying far inside the server's documented 1-per-5s /state budget.
STATE_MAX_AGE = 10.0

# --- Upstream Companion Server budget -------------------------------------
# The Companion Server rate-limits every route and documents the limits so
# clients stop hammering it: /state 1 per 5 s, /playlists 1 per 30 s,
# /command 2 per s, /auth/* 5 per min. Realtime is meant to come from
# Socket.IO, not from polling.
STATE_MIN_INTERVAL = 5.0
COMMAND_TIMEOUT = 10.0
PLAYLISTS_TIMEOUT = 45.0      # upstream can take up to 30 s
AUTH_TIMEOUT = 45.0           # upstream blocks up to 30 s awaiting user approval
BACKOFF_MIN = 1.0
BACKOFF_MAX = 30.0

# All 20 Companion Server v1 commands supported as of YTMDesktop v2.1.0.
AllowedCommand = Literal[
    "playPause",
    "play",
    "pause",
    "volumeUp",
    "volumeDown",
    "setVolume",
    "mute",
    "unmute",
    "seekTo",
    "next",
    "previous",
    "repeatMode",
    "shuffle",
    "playQueueIndex",
    "changeVideo",
    "toggleLike",
    "toggleDislike",
    "queueAdd",
    "queueRemove",
    "queueMove",
]

# ---------------------------------------------------------------------------
# Paths / persisted config
# ---------------------------------------------------------------------------


def _data_dir():
    """Plugin-private data dir, honouring HERMES_HOME and the active profile."""
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "plugin-data" / PLUGIN_ID


def _config_path():
    return _data_dir() / "config.json"


_config_cache: Optional[Dict[str, Any]] = None


def load_config() -> Optional[Dict[str, Any]]:
    global _config_cache
    if _config_cache is not None:
        return _config_cache
    try:
        raw = _config_path().read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        return None
    try:
        cfg = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(cfg, dict):
        return None
    _config_cache = cfg
    return cfg


def save_config(cfg: Dict[str, Any]) -> None:
    global _config_cache
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic: never leave a half-written config behind for the next reader.
    tmp = path.parent / (path.name + ".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    try:
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    os.replace(tmp, path)
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    _config_cache = cfg


def _redact_error(text: str, token: Optional[str] = None) -> str:
    """Ensure auth tokens never leak into diagnostic strings or HTTP error details."""
    cleaned = text or ""
    if token and len(token) >= 6:
        cleaned = cleaned.replace(token, "[REDACTED]")
    return cleaned[:240]


# ---------------------------------------------------------------------------
# Address validation
# ---------------------------------------------------------------------------


def _is_private_ipv4(host: str) -> bool:
    parts = host.split(".")
    if len(parts) != 4 or not all(p.isdigit() for p in parts):
        return False
    octets = [int(p) for p in parts]
    if any(o < 0 or o > 255 for o in octets):
        return False
    if octets[0] in (10, 127):
        return True
    if octets[0] == 192 and octets[1] == 168:
        return True
    if octets[0] == 172 and 16 <= octets[1] <= 31:
        return True
    return False


def normalize_base_url(raw: str) -> str:
    """Validate and normalise a Companion Server base URL.

    The Companion Server only listens on IPv4, and the upstream docs warn that
    ``localhost`` resolves to ``::1`` on Windows — which the server does not
    answer. Pin it to 127.0.0.1 so a config that works on one machine cannot
    silently break on another.
    """
    url = (raw or "").strip()
    if not url:
        raise ValueError("A Companion Server URL is required.")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("The URL must start with http:// or https://")
    host = (parsed.hostname or "").lower()
    if host == "localhost":
        host = "127.0.0.1"
    if not _is_private_ipv4(host):
        raise ValueError(
            "The Companion Server must be localhost or a private LAN IPv4 address "
            "(127.x, 10.x, 192.168.x, 172.16-31.x). Public addresses are refused so a "
            "stored token cannot be repointed at an arbitrary host."
        )
    port = parsed.port or 9863
    return f"{parsed.scheme}://{host}:{port}"


def _socketio_available() -> bool:
    try:
        import socketio  # noqa: F401
    except ImportError:
        return False
    return True


# ---------------------------------------------------------------------------
# Payload trimming & event push to the desktop half
# ---------------------------------------------------------------------------


def _slim_queue_item(item: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    # Strip heavy `counterparts` and oversized thumbnail arrays on every queue
    # entry so 1s progress ticks don't push ~96 KB across the gateway event bus.
    thumbs = item.get("thumbnails")
    slim_thumbs = thumbs[:2] if isinstance(thumbs, list) else []
    return {
        "title": item.get("title"),
        "author": item.get("author"),
        "duration": item.get("duration"),
        "selected": item.get("selected"),
        "videoId": item.get("videoId"),
        "thumbnails": slim_thumbs,
    }


def _slim_state(state: Dict[str, Any]) -> Dict[str, Any]:
    """Return a compact copy of the Companion Server state payload (~96 KB -> ~6 KB)."""
    if not isinstance(state, dict):
        return state
    player = state.get("player")
    if not isinstance(player, dict):
        return state
    queue = player.get("queue")
    if not isinstance(queue, dict):
        return state

    raw_items = queue.get("items")
    items = [s for x in (raw_items if isinstance(raw_items, list) else []) if (s := _slim_queue_item(x)) is not None]
    raw_automix = queue.get("automixItems")
    automix_count = len(raw_automix) if isinstance(raw_automix, list) else 0

    slim_queue = {
        "autoplay": queue.get("autoplay"),
        "items": items,
        "automixCount": automix_count,
        "isGenerating": queue.get("isGenerating"),
        "isInfinite": queue.get("isInfinite"),
        "repeatMode": queue.get("repeatMode"),
        "selectedItemIndex": queue.get("selectedItemIndex"),
        "shuffleEnabled": bool(queue.get("shuffleEnabled", False)),
    }
    return {
        **state,
        "player": {
            **player,
            "queue": slim_queue,
        },
    }


def _broadcast(event: str, payload: Optional[Dict[str, Any]] = None) -> None:
    """Push ``plugin.<plugin_id>.<event>`` to every connected desktop client.

    The desktop half subscribes with ``host.onEvent('plugin.ytm-control.<event>')``.
    """
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
    except ImportError:
        return
    try:
        broadcast_plugin_event(PLUGIN_ID, event, payload or {})
    except Exception:
        # Fire-and-forget: a delivery failure must never break a request handler.
        pass


# ---------------------------------------------------------------------------
# Socket.IO realtime bridge
# ---------------------------------------------------------------------------

_bridge: Dict[str, Any] = {
    "task": None,
    "connected": False,
    "state": None,
    "state_at": 0.0,
    "last_error": None,
    "generation": 0,
}


def _record_state(raw_state: Dict[str, Any]) -> Dict[str, Any]:
    slim = _slim_state(raw_state)
    _bridge["state"] = slim
    _bridge["state_at"] = time.monotonic()
    _broadcast("state.updated", slim)
    return slim


async def _bridge_loop(generation: int) -> None:
    """Connect to the Companion Server's Socket.IO endpoint, forever.

    Deliberately owns its own reconnect loop (``reconnection=False`` on the
    client): the client's internal reconnection and an outer retry loop fight
    each other, and the v0.4 mix of both left the outer loop as dead code that
    could never run. Backoff is exponential with a ceiling.
    """
    delay = BACKOFF_MIN
    while _bridge["generation"] == generation:
        cfg = load_config() or {}
        base = cfg.get("baseUrl")
        token = cfg.get("token")
        if not base or not token:
            await asyncio.sleep(2.0)
            continue

        try:
            import socketio
        except ImportError:
            _bridge["last_error"] = "python-socketio is not installed; realtime disabled"
            await asyncio.sleep(30.0)
            continue

        sio = socketio.AsyncClient(reconnection=False)

        # Every handler MUST carry the namespace — a handler registered on the
        # default namespace never fires for events emitted on this one.
        @sio.event(namespace=REALTIME_NAMESPACE)
        async def connect(*_args: Any, **_kwargs: Any) -> None:
            _bridge["connected"] = True
            _bridge["last_error"] = None
            _broadcast("connection.changed", {"connected": True})

        @sio.event(namespace=REALTIME_NAMESPACE)
        async def disconnect(*_args: Any, **_kwargs: Any) -> None:
            _bridge["connected"] = False
            _broadcast("connection.changed", {"connected": False})

        @sio.on("state-update", namespace=REALTIME_NAMESPACE)
        async def state_update(*args: Any, **_kwargs: Any) -> None:
            state = args[0] if args else None
            if isinstance(state, dict):
                _record_state(state)

        @sio.on("playlist-created", namespace=REALTIME_NAMESPACE)
        async def playlist_created(*_args: Any, **_kwargs: Any) -> None:
            _broadcast("playlists.changed", {})

        @sio.on("playlist-deleted", namespace=REALTIME_NAMESPACE)
        async def playlist_deleted(*_args: Any, **_kwargs: Any) -> None:
            _broadcast("playlists.changed", {})

        try:
            # NOTE: the namespace goes in `namespaces=`, never in the URL.
            await sio.connect(
                base,
                auth={"token": token},
                namespaces=[REALTIME_NAMESPACE],
                transports=["websocket"],
                wait_timeout=10,
            )
            delay = BACKOFF_MIN
            await sio.wait()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - any transport failure retries
            _bridge["last_error"] = _redact_error(f"{type(exc).__name__}: {exc}", token)
        finally:
            _bridge["connected"] = False
            try:
                if sio.connected:
                    await sio.disconnect()
            except Exception:
                pass

        if _bridge["generation"] != generation:
            return
        await asyncio.sleep(delay)
        delay = min(delay * 2, BACKOFF_MAX)


def _ensure_bridge() -> None:
    """Start the bridge if it is not running. Safe to call on every request."""
    task = _bridge.get("task")
    if task is not None and not task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No loop yet (import time, sync context). The next HTTP request starts it.
        return
    _bridge["task"] = loop.create_task(_bridge_loop(_bridge["generation"]))


def _restart_bridge() -> None:
    """Force a reconnect after the config or token changed."""
    _bridge["generation"] += 1
    task = _bridge.get("task")
    if task is not None and not task.done():
        task.cancel()
    _bridge["task"] = None
    _ensure_bridge()


async def _bridge_dependency() -> None:
    _ensure_bridge()


# Every route keeps the bridge alive, so no route can leave realtime silently
# dead (v0.4 only started it from /health and /configure, so after a restart the
# bridge stayed down until something happened to call one of those two).
router = APIRouter(dependencies=[Depends(_bridge_dependency)])


# ---------------------------------------------------------------------------
# Upstream HTTP (pooled client + rate-limit lock)
# ---------------------------------------------------------------------------

_http_client: Optional[httpx.AsyncClient] = None
_http_client_loop: Any = None


def _get_http_client() -> httpx.AsyncClient:
    """Return a pooled AsyncClient bound to the current running event loop."""
    global _http_client, _http_client_loop
    loop = asyncio.get_running_loop()
    if _http_client is None or _http_client.is_closed or _http_client_loop is not loop:
        _http_client = httpx.AsyncClient(
            timeout=COMMAND_TIMEOUT,
            limits=httpx.Limits(max_keepalive_connections=4, max_connections=10),
        )
        _http_client_loop = loop
    return _http_client


def _require_config() -> Dict[str, Any]:
    cfg = load_config()
    if not cfg or not cfg.get("baseUrl"):
        raise HTTPException(status_code=409, detail="The Companion Server is not configured.")
    if not cfg.get("token"):
        raise HTTPException(status_code=401, detail="Not authorised. Connect first.")
    return cfg


async def _upstream(
    method: str,
    path: str,
    cfg: Dict[str, Any],
    *,
    timeout: float = COMMAND_TIMEOUT,
    json_body: Any = None,
) -> Any:
    url = f"{cfg['baseUrl']}/api/v1{path}"
    token = cfg["token"]
    headers = {"Authorization": token, "Content-Type": "application/json"}
    client = _get_http_client()
    try:
        res = await client.request(method, url, headers=headers, json=json_body, timeout=timeout)
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504, detail="The Companion Server did not answer in time."
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=_redact_error(f"Companion Server unreachable: {exc}", token),
        )
    if res.status_code >= 400:
        raise HTTPException(
            status_code=res.status_code,
            detail=_redact_error(res.text[:300], token),
        )
    if not res.content:
        return None
    try:
        return res.json()
    except ValueError:
        return None


_state_fetch_at = 0.0
_state_lock: Optional[asyncio.Lock] = None
_state_lock_loop: Any = None


def _get_state_lock() -> asyncio.Lock:
    global _state_lock, _state_lock_loop
    loop = asyncio.get_running_loop()
    if _state_lock is None or _state_lock_loop is not loop:
        _state_lock = asyncio.Lock()
        _state_lock_loop = loop
    return _state_lock


async def _hydrate_state(cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Fetch state over REST, serialized and throttled to the upstream 1-per-5s limit."""
    global _state_fetch_at
    async with _get_state_lock():
        now = time.monotonic()
        cached = _bridge.get("state")
        fresh = (now - float(_bridge.get("state_at") or 0.0)) < STATE_MAX_AGE
        if isinstance(cached, dict) and fresh:
            return cached
        if now - _state_fetch_at < STATE_MIN_INTERVAL:
            return cached if isinstance(cached, dict) else None
        _state_fetch_at = now
        data = await _upstream("GET", "/state", cfg)
        if isinstance(data, dict):
            return _record_state(data)
        return None


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class ConfigureBody(BaseModel):
    baseUrl: Optional[str] = None
    appId: Optional[str] = None


class RequestCodeBody(BaseModel):
    baseUrl: Optional[str] = None


class RequestTokenBody(BaseModel):
    code: str


class CommandBody(BaseModel):
    command: AllowedCommand
    data: Any = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/health")
async def health() -> Dict[str, Any]:
    cfg = load_config() or {}
    return {
        "ok": True,
        "version": VERSION,
        "configured": bool(cfg.get("baseUrl")),
        "hasToken": bool(cfg.get("token")),
        "realtime": _socketio_available(),
        "bridge": {
            "connected": bool(_bridge["connected"]),
            "lastError": _bridge.get("last_error"),
        },
    }


@router.get("/config")
async def get_config() -> Dict[str, Any]:
    """Current connection settings. The token itself is never returned."""
    cfg = load_config() or {}
    return {
        "baseUrl": cfg.get("baseUrl") or DEFAULT_BASE_URL,
        "appId": cfg.get("appId") or DEFAULT_APP_ID,
        "hasToken": bool(cfg.get("token")),
    }


@router.get("/probe")
async def probe() -> Dict[str, Any]:
    """Reachability probe. Hits the unauthenticated /metadata endpoint upstream.

    ``/metadata`` is deliberately *not* under ``/api/v1`` — it is the one route
    that answers without a token, which makes it the right "is it there?" test.
    """
    cfg = load_config() or {}
    base = cfg.get("baseUrl") or DEFAULT_BASE_URL
    client = _get_http_client()
    try:
        res = await client.get(f"{base}/metadata", timeout=5.0)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"No Companion Server answered at {base} ({exc})."
        )
    if res.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"{base} answered HTTP {res.status_code}.")
    try:
        return res.json()
    except ValueError:
        return {"apiVersions": []}


@router.post("/configure")
async def configure(body: ConfigureBody) -> Dict[str, Any]:
    cfg = dict(load_config() or {})
    previous_base = cfg.get("baseUrl")
    previous_app = cfg.get("appId")

    if body.baseUrl is not None:
        try:
            cfg["baseUrl"] = normalize_base_url(body.baseUrl)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    if body.appId is not None:
        app_id = body.appId.strip()
        if app_id and not re.fullmatch(r"[a-z0-9_\-]{2,32}", app_id):
            raise HTTPException(
                status_code=400,
                detail="App ID must be 2-32 lowercase alphanumeric characters, hyphens, or underscores.",
            )
        cfg["appId"] = app_id or DEFAULT_APP_ID

    cfg.setdefault("appId", DEFAULT_APP_ID)
    if not cfg.get("baseUrl"):
        raise HTTPException(status_code=400, detail="A Companion Server URL is required.")

    # A token is bound to the appId that requested it, and is only valid on the
    # server that issued it. Pointing at a different server or renaming the app
    # therefore invalidates the token — drop it rather than fail with endless 401s.
    moved = previous_base is not None and cfg["baseUrl"] != previous_base
    renamed = previous_app is not None and cfg["appId"] != previous_app
    if (moved or renamed) and cfg.get("token"):
        cfg.pop("token", None)
        _bridge["state"] = None
        _bridge["state_at"] = 0.0

    save_config(cfg)
    _restart_bridge()
    return {
        "ok": True,
        "baseUrl": cfg["baseUrl"],
        "appId": cfg["appId"],
        "hasToken": bool(cfg.get("token")),
    }


@router.post("/auth/requestcode")
async def auth_request_code(body: RequestCodeBody | None = None) -> Dict[str, Any]:
    """Ask the Companion Server for a pairing code to show the user."""
    cfg = dict(load_config() or {})
    if body is not None and body.baseUrl:
        try:
            cfg["baseUrl"] = normalize_base_url(body.baseUrl)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    if not cfg.get("baseUrl"):
        raise HTTPException(status_code=409, detail="Set the Companion Server URL first.")
    cfg.setdefault("appId", DEFAULT_APP_ID)
    # Persist the URL before the (possibly slow) approval so a reload keeps it.
    save_config(cfg)

    payload = {"appId": cfg["appId"], "appName": APP_NAME, "appVersion": VERSION}
    client = _get_http_client()
    try:
        res = await client.post(
            f"{cfg['baseUrl']}/api/v1/auth/requestcode",
            json=payload,
            timeout=COMMAND_TIMEOUT,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Companion Server unreachable: {exc}")
    if res.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"The Companion Server rejected the code request (HTTP {res.status_code}).",
        )
    try:
        code = (res.json() or {}).get("code")
    except ValueError:
        code = None
    if not code:
        raise HTTPException(status_code=502, detail="The Companion Server returned no code.")
    return {"code": code, "baseUrl": cfg["baseUrl"], "appId": cfg["appId"]}


@router.post("/auth/request")
async def auth_request(body: RequestTokenBody) -> Dict[str, Any]:
    """Exchange the pairing code for a token. Blocks while the user approves."""
    cfg = dict(load_config() or {})
    if not cfg.get("baseUrl"):
        raise HTTPException(status_code=409, detail="Set the Companion Server URL first.")
    code = (body.code or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="A pairing code is required.")

    payload = {"appId": cfg.get("appId") or DEFAULT_APP_ID, "code": code}
    client = _get_http_client()
    try:
        res = await client.post(
            f"{cfg['baseUrl']}/api/v1/auth/request",
            json=payload,
            timeout=AUTH_TIMEOUT,
        )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=408,
            detail="Timed out waiting for approval in YT Music Desktop. "
            "Approve the request there, then try again.",
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Companion Server unreachable: {exc}")

    denied = HTTPException(
        status_code=403,
        detail="Authorisation was denied or the code expired. Start over for a new code.",
    )
    if res.status_code >= 400:
        raise denied
    try:
        token = (res.json() or {}).get("token")
    except ValueError:
        token = None
    if not token:
        raise denied

    cfg["token"] = token
    save_config(cfg)
    _restart_bridge()
    return {"ok": True, "hasToken": True}


@router.delete("/auth")
async def auth_forget() -> Dict[str, Any]:
    cfg = dict(load_config() or {})
    cfg.pop("token", None)
    save_config(cfg)
    _bridge["state"] = None
    _bridge["state_at"] = 0.0
    _restart_bridge()
    return {"ok": True, "hasToken": False}


@router.get("/state")
async def get_state() -> Dict[str, Any]:
    """Player state: the pushed snapshot while it is fresh, REST otherwise.

    v0.4.1 served `_bridge["state"]` whenever it was set, with no age check.
    When the socket went quiet that turned into a permanently frozen snapshot —
    the pane stopped updating entirely, which is exactly the v0.4.2 bug report.
    A stale snapshot is now refreshed over REST (throttled below to the
    server's own 1-per-5s budget), and only served as a last resort if the
    refresh fails.
    """
    cfg = _require_config()
    cached = _bridge.get("state")
    fresh = (time.monotonic() - float(_bridge.get("state_at") or 0.0)) < STATE_MAX_AGE
    if isinstance(cached, dict) and fresh:
        return cached
    data = await _hydrate_state(cfg)
    if data is None:
        if isinstance(cached, dict):
            return cached  # stale beats nothing
        raise HTTPException(
            status_code=502, detail="No state available from the Companion Server yet."
        )
    return data


@router.post("/command")
async def post_command(body: CommandBody) -> Dict[str, Any]:
    cfg = _require_config()
    payload: Dict[str, Any] = {"command": body.command}
    if body.data is not None:
        payload["data"] = body.data
    await _upstream("POST", "/command", cfg, json_body=payload)
    return {"ok": True}


@router.get("/playlists")
async def get_playlists() -> Any:
    cfg = _require_config()
    data = await _upstream("GET", "/playlists", cfg, timeout=PLAYLISTS_TIMEOUT)
    return data if data is not None else []
