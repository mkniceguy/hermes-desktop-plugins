"""plex-status v0.3.0 — backend bridge for Tautulli (Plex monitoring).

This backend is the *single source of truth* for the plugin. It owns:

  * the persisted connection config and the Tautulli API key
    (stored on disk at ``<hermes_home>/plugin-data/plex-status/config.json``
    with mode 0600, never exposed to the browser renderer),
  * URL validation (restricting plain ``http://`` to loopback, RFC1918 private
    LAN, Tailscale CGNAT, and ``.local``/``.lan``/``.home.arpa`` hosts while
    requiring ``https://`` for public hosts so an API key is never transmitted
    in cleartext over the internet),
  * serialized, rate-limited, cached HTTP calls to Tautulli's ``/api/v2``
    endpoint so multiple mounted UI surfaces (the right-side pane and the
    statusbar mini-chip) share a single upstream cache and never hammer the
    server.

The desktop half only ever talks to this namespace —
``/api/plugins/plex-status/`` — via ``ctx.rest`` and receives push updates via
``host.onEvent('plugin.plex-status.<event>')``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import stat
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

PLUGIN_ID = "plex-status"
VERSION = "0.3.0"

ACTIVITY_MAX_AGE = 5.0
RECENT_MAX_AGE = 30.0
UPSTREAM_TIMEOUT = 10.0
DEFAULT_RECENT_COUNT = 8

router = APIRouter()

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
    except (FileNotFoundError, OSError):
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


def _redact_error(text: str, api_key: Optional[str] = None) -> str:
    """Ensure the Tautulli API key never leaks into HTTP error details."""
    cleaned = text or ""
    if api_key and len(api_key) >= 4:
        cleaned = cleaned.replace(api_key, "[REDACTED]")
    cleaned = re.sub(r"apikey=[^&\s]+", "apikey=[REDACTED]", cleaned, flags=re.IGNORECASE)
    return cleaned[:240]


# ---------------------------------------------------------------------------
# Address validation
# ---------------------------------------------------------------------------


def _is_private_or_tailscale_ipv4(host: str) -> bool:
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
    if octets[0] == 100 and 64 <= octets[1] <= 127:
        return True
    return False


def _is_local_hostname(host: str) -> bool:
    if host in ("localhost", "::1", "[::1]"):
        return True
    if any(host.endswith(suffix) for suffix in (".local", ".lan", ".internal", ".home.arpa")):
        return True
    if "." not in host:
        return True
    return False


def normalize_base_url(raw: str) -> str:
    """Validate and normalise a Tautulli base URL (preserving optional web_root)."""
    url = (raw or "").strip().rstrip("/")
    if not url:
        raise ValueError("A Tautulli URL is required.")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("The URL must start with http:// or https://")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError("Enter a valid Tautulli URL (e.g. http://192.168.0.3:30047).")

    if parsed.scheme == "http" and not (_is_private_or_tailscale_ipv4(host) or _is_local_hostname(host)):
        raise ValueError(
            "Plain HTTP is only allowed for localhost, private LAN (10.x, 172.16-31.x, 192.168.x), "
            "or Tailscale (100.64-127.x) addresses. Use https:// for remote hosts so your Tautulli "
            "API key is never sent in cleartext over the internet."
        )

    netloc = parsed.netloc
    path = (parsed.path or "").rstrip("/")
    return f"{parsed.scheme}://{netloc}{path}"


# ---------------------------------------------------------------------------
# Event broadcast & slimming
# ---------------------------------------------------------------------------


def _broadcast(event: str, payload: Optional[Dict[str, Any]] = None) -> None:
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
    except ImportError:
        return
    try:
        broadcast_plugin_event(PLUGIN_ID, event, payload or {})
    except Exception:
        pass


def _slim_activity(d: Dict[str, Any]) -> Dict[str, Any]:
    stream_count = int(d.get("stream_count") or 0)
    direct_play_count = int(d.get("stream_count_direct_play") or 0)
    direct_stream_count = int(d.get("stream_count_direct_stream") or 0)
    transcode_count = int(d.get("stream_count_transcode") or 0)

    total_bw = round((float(d.get("total_bandwidth") or 0.0)) / 1000.0, 1)
    lan_bw = round((float(d.get("lan_bandwidth") or 0.0)) / 1000.0, 1)
    wan_bw = round((float(d.get("wan_bandwidth") or 0.0)) / 1000.0, 1)

    sessions: List[Dict[str, Any]] = []
    for s in d.get("sessions") or []:
        if not isinstance(s, dict):
            continue
        mt = str(s.get("media_type") or "").lower()
        transcode = str(s.get("transcode_decision") or "").lower()
        legs: List[str] = []
        if str(s.get("stream_video_decision") or s.get("video_decision") or "").lower() == "transcode":
            legs.append("video")
        if str(s.get("stream_audio_decision") or s.get("audio_decision") or "").lower() == "transcode":
            legs.append("audio")
        if str(s.get("stream_subtitle_decision") or s.get("subtitle_decision") or "").lower() == "transcode":
            legs.append("subtitle")

        hw_dec = str(s.get("transcode_hw_decoding") or "") in ("1", "true", "True")
        hw_enc = str(s.get("transcode_hw_encoding") or "") in ("1", "true", "True")
        hw = hw_dec or hw_enc

        p_idx = str(s.get("parent_media_index") or "").strip()
        m_idx = str(s.get("media_index") or "").strip()
        ep_code = ""
        if mt == "episode" and p_idx.isdigit() and m_idx.isdigit():
            ep_code = f"S{int(p_idx):02d}E{int(m_idx):02d}"

        grandparent = s.get("grandparent_title") or ""
        raw_title = s.get("title") or s.get("full_title") or "Unknown"
        if grandparent and mt == "episode":
            title = f"{grandparent} · {ep_code} — {raw_title}" if ep_code else f"{grandparent} — {raw_title}"
        elif grandparent and mt in ("track", "music"):
            title = f"{grandparent} — {raw_title}"
        else:
            title = str(raw_title)

        try:
            progress = max(0, min(100, int(float(s.get("progress_percent") or 0))))
        except (ValueError, TypeError):
            progress = 0

        bw_mbps = round((float(s.get("bandwidth") or 0.0)) / 1000.0, 1)
        location = str(s.get("location") or "").lower()  # 'lan' or 'wan'

        sessions.append(
            {
                "key": f"{s.get('session_key') or s.get('id') or ''}|{s.get('user') or ''}|{title}|{transcode}",
                "title": title,
                "user": s.get("friendly_name") or s.get("user") or s.get("username") or "unknown",
                "state": str(s.get("state") or "").lower(),
                "progress": progress,
                "quality": s.get("quality_profile") or s.get("stream_video_full_resolution") or "",
                "player": s.get("player") or s.get("platform") or "",
                "location": location,
                "bandwidthMbps": f"{bw_mbps:.1f}" if bw_mbps > 0 else "",
                "decision": transcode or "direct play",
                "transcoding": transcode == "transcode",
                "transcodeHw": hw,
                "transcodeLegs": legs,
                "verb": "listening to" if mt in ("track", "music") else "watching",
            }
        )

    return {
        "streamCount": stream_count,
        "directPlayCount": direct_play_count,
        "directStreamCount": direct_stream_count,
        "transcodeCount": transcode_count,
        "bandwidthMbps": f"{total_bw:.1f}",
        "lanBandwidthMbps": f"{lan_bw:.1f}",
        "wanBandwidthMbps": f"{wan_bw:.1f}",
        "sessions": sessions,
        "fetchedAt": int(time.time()),
    }


def _slim_recent(d: Dict[str, Any]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for r in d.get("recently_added") or []:
        if not isinstance(r, dict):
            continue
        mt = str(r.get("media_type") or "").lower()
        p_idx = str(r.get("parent_media_index") or "").strip()
        m_idx = str(r.get("media_index") or "").strip()
        ep_code = ""
        if mt == "episode" and p_idx.isdigit() and m_idx.isdigit():
            ep_code = f"S{int(p_idx):02d}E{int(m_idx):02d}"
        elif mt == "season" and m_idx.isdigit():
            ep_code = f"Season {int(m_idx)}"

        grandparent = r.get("grandparent_title") or ""
        parent = r.get("parent_title") or ""
        raw_title = r.get("title") or "Unknown"

        if mt == "episode" and grandparent:
            title = f"{grandparent} · {ep_code} — {raw_title}" if ep_code else f"{grandparent} — {raw_title}"
        elif mt == "season" and parent:
            title = f"{parent} — {raw_title}"
        elif mt == "album" and parent:
            title = f"{parent} — {raw_title}"
        else:
            title = str(raw_title)

        year = str(r.get("year") or "").strip()
        added_at = int(r.get("added_at") or 0) if str(r.get("added_at") or "").isdigit() else 0

        items.append(
            {
                "title": title,
                "mediaType": mt or "media",
                "year": year,
                "addedAt": added_at,
            }
        )
    return items


# ---------------------------------------------------------------------------
# Upstream HTTP (lazy httpx + pooled client + cache locks)
# ---------------------------------------------------------------------------

_http_client: Any = None
_http_client_loop: Any = None

_cache: Dict[str, Any] = {
    "activity": None,
    "activity_at": 0.0,
    "recent": None,
    "recent_at": 0.0,
    "last_error": None,
}

_activity_lock: Optional[asyncio.Lock] = None
_activity_lock_loop: Any = None


def _get_activity_lock() -> asyncio.Lock:
    global _activity_lock, _activity_lock_loop
    loop = asyncio.get_running_loop()
    if _activity_lock is None or _activity_lock_loop is not loop:
        _activity_lock = asyncio.Lock()
        _activity_lock_loop = loop
    return _activity_lock


def _get_http_client():
    """Lazily import httpx and return a pooled AsyncClient bound to the current loop."""
    global _http_client, _http_client_loop
    import httpx

    loop = asyncio.get_running_loop()
    if _http_client is None or _http_client.is_closed or _http_client_loop is not loop:
        _http_client = httpx.AsyncClient(
            timeout=UPSTREAM_TIMEOUT,
            limits=httpx.Limits(max_keepalive_connections=4, max_connections=10),
        )
        _http_client_loop = loop
    return _http_client


def _require_config() -> Dict[str, Any]:
    cfg = load_config()
    if not cfg or not cfg.get("baseUrl") or not cfg.get("apiKey"):
        raise HTTPException(status_code=409, detail="Tautulli is not configured.")
    return cfg


async def _call_tautulli(
    base_url: str,
    api_key: str,
    cmd: str,
    params: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    import httpx

    client = _get_http_client()
    query = {"apikey": api_key, "cmd": cmd}
    if params:
        query.update(params)

    try:
        res = await client.get(f"{base_url}/api/v2", params=query, timeout=UPSTREAM_TIMEOUT)
    except httpx.TimeoutException:
        err = "Tautulli did not answer in time."
        _cache["last_error"] = err
        raise HTTPException(status_code=504, detail=err)
    except httpx.HTTPError as exc:
        err = _redact_error(f"Tautulli unreachable: {exc}", api_key)
        _cache["last_error"] = err
        raise HTTPException(status_code=502, detail=err)

    if res.status_code >= 400:
        err = _redact_error(f"Tautulli answered HTTP {res.status_code}", api_key)
        _cache["last_error"] = err
        raise HTTPException(status_code=502, detail=err)

    try:
        body = res.json()
    except ValueError:
        err = "Tautulli returned invalid JSON (check URL / web_root)."
        _cache["last_error"] = err
        raise HTTPException(status_code=502, detail=err)

    inner = body.get("response") if isinstance(body, dict) else None
    if not isinstance(inner, dict) or inner.get("result") != "success":
        msg = (inner.get("message") if isinstance(inner, dict) else None) or "Tautulli API error (check API key)."
        err = _redact_error(str(msg), api_key)
        _cache["last_error"] = err
        raise HTTPException(status_code=401 if "api" in err.lower() or "key" in err.lower() else 502, detail=err)

    _cache["last_error"] = None
    data = inner.get("data")
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------------------
# Models & Routes
# ---------------------------------------------------------------------------


class ConfigureBody(BaseModel):
    baseUrl: str
    apiKey: Optional[str] = None


@router.get("/health")
async def health() -> Dict[str, Any]:
    cfg = load_config() or {}
    return {
        "ok": True,
        "version": VERSION,
        "configured": bool(cfg.get("baseUrl") and cfg.get("apiKey")),
        "lastError": _cache.get("last_error"),
    }


@router.get("/config")
async def get_config() -> Dict[str, Any]:
    """Current connection settings. The API key itself is never returned."""
    cfg = load_config() or {}
    return {
        "baseUrl": cfg.get("baseUrl") or "",
        "hasKey": bool(cfg.get("apiKey")),
    }


@router.post("/configure")
async def configure(body: ConfigureBody) -> Dict[str, Any]:
    """Validate URL, test live against Tautulli get_activity, and persist."""
    try:
        base_url = normalize_base_url(body.baseUrl)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    existing = load_config() or {}
    api_key = (body.apiKey or "").strip() or str(existing.get("apiKey") or "").strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="A Tautulli API key is required.")

    # Verify the URL + API key live against Tautulli before saving
    raw_activity = await _call_tautulli(base_url, api_key, "get_activity")
    slim = _slim_activity(raw_activity)

    cfg = {"baseUrl": base_url, "apiKey": api_key}
    save_config(cfg)

    _cache["activity"] = slim
    _cache["activity_at"] = time.monotonic()
    _cache["recent"] = None
    _cache["recent_at"] = 0.0
    _broadcast("activity.updated", slim)
    _broadcast("config.changed", {"configured": True})

    return {
        "ok": True,
        "baseUrl": base_url,
        "hasKey": True,
        "activity": slim,
    }


@router.delete("/auth")
async def forget_auth() -> Dict[str, Any]:
    save_config({})
    _cache["activity"] = None
    _cache["activity_at"] = 0.0
    _cache["recent"] = None
    _cache["recent_at"] = 0.0
    _cache["last_error"] = None
    _broadcast("config.changed", {"configured": False})
    return {"ok": True, "hasKey": False}


@router.get("/activity")
async def get_activity(force: bool = False) -> Dict[str, Any]:
    cfg = _require_config()
    async with _get_activity_lock():
        now = time.monotonic()
        cached = _cache.get("activity")
        if not force and isinstance(cached, dict) and (now - float(_cache.get("activity_at") or 0.0)) < ACTIVITY_MAX_AGE:
            return cached

        raw = await _call_tautulli(cfg["baseUrl"], cfg["apiKey"], "get_activity")
        slim = _slim_activity(raw)
        _cache["activity"] = slim
        _cache["activity_at"] = time.monotonic()
        _broadcast("activity.updated", slim)
        return slim


@router.get("/recent")
async def get_recent(count: int = DEFAULT_RECENT_COUNT, force: bool = False) -> Dict[str, Any]:
    cfg = _require_config()
    safe_count = max(1, min(20, int(count or DEFAULT_RECENT_COUNT)))
    now = time.monotonic()
    cached = _cache.get("recent")
    if (
        not force
        and isinstance(cached, list)
        and len(cached) == safe_count
        and (now - float(_cache.get("recent_at") or 0.0)) < RECENT_MAX_AGE
    ):
        return {"items": cached}

    raw = await _call_tautulli(
        cfg["baseUrl"],
        cfg["apiKey"],
        "get_recently_added",
        params={"count": str(safe_count)},
    )
    items = _slim_recent(raw)
    _cache["recent"] = items
    _cache["recent_at"] = time.monotonic()
    return {"items": items}
