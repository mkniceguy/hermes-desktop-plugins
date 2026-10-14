"""ytm-control v0.4 backend bridge.

Mounts under /api/plugins/ytm-control/. Owns the Socket.IO connection to the
YT Music Desktop Companion Server and pushes state updates to the desktop half
via broadcast_plugin_event('ytm-control', 'state.updated', payload).
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Dict, Optional

import httpx
import socketio
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

PLUGIN_ID = "ytm-control"
CONFIG_DIR = os.path.expanduser("~/.hermes/plugin-data/ytm-control")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")

# ---------------------------------------------------------------------------
# In-memory runtime state
# ---------------------------------------------------------------------------
_runtime: Dict[str, Any] = {
    "config": None,
    "token": None,
    "connected": False,
    "last_state": None,
    "task": None,
}
sio = socketio.AsyncClient(reconnection=True)


def is_private_host(url: str) -> bool:
    from urllib.parse import urlparse

    u = urlparse(url)
    if u.scheme not in ("http", "https"):
        return False
    h = (u.hostname or "").lower()
    if h == "localhost":
        return True
    if not h.count(".") == 3:
        return False
    if not all(p.isdigit() for p in h.split(".")):
        return False
    parts = [int(p) for p in h.split(".")]
    if any(p < 0 or p > 255 for p in parts):
        return False
    if parts[0] == 10 or parts[0] == 127:
        return True
    if parts[0] == 192 and parts[1] == 168:
        return True
    if parts[0] == 172 and 16 <= parts[1] <= 31:
        return True
    return False


# ---------------------------------------------------------------------------
# Config persistence
# ---------------------------------------------------------------------------
def load_config() -> Optional[Dict[str, Any]]:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        _runtime["config"] = cfg
        _runtime["token"] = cfg.get("token")
        return cfg
    except FileNotFoundError:
        return None
    except Exception:
        return None


def save_config(cfg: Dict[str, Any]) -> None:
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh)
    _runtime["config"] = cfg
    _runtime["token"] = cfg.get("token")


# ---------------------------------------------------------------------------
# Socket.IO bridge
# ---------------------------------------------------------------------------
@sio.event
async def connect():
    _runtime["connected"] = True


@sio.event
async def disconnect():
    _runtime["connected"] = False


@sio.on("state-update")
async def on_state_update(state):
    _runtime["last_state"] = state
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event(PLUGIN_ID, "state.updated", state if isinstance(state, dict) else {})
    except Exception:
        pass


async def _bridge_task():
    while True:
        cfg = load_config() or _runtime.get("config")
        if not cfg or not cfg.get("baseUrl") or not cfg.get("token"):
            await asyncio.sleep(5)
            continue
        base = cfg["baseUrl"].rstrip("/")
        try:
            await sio.connect(
                f"{base}/api/v1/realtime",
                auth={"token": cfg["token"]},
                transports=["websocket"],
                wait_timeout=10,
            )
            await sio.wait()
        except Exception:
            await asyncio.sleep(5)
            try:
                if sio.connected:
                    await sio.disconnect()
            except Exception:
                pass


def _ensure_bridge():
    if _runtime.get("task") is None or _runtime["task"].done():
        _runtime["task"] = asyncio.ensure_future(_bridge_task())


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class ConfigureBody(BaseModel):
    baseUrl: str
    token: Optional[str] = None
    appId: Optional[str] = "hermesdesktop01"


class CommandBody(BaseModel):
    command: str
    data: Any = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("/health")
async def health():
    _ensure_bridge()
    return {
        "ok": True,
        "version": "0.4.0-scaffold",
        "bridgeConnected": bool(sio.connected),
        "hasConfig": bool(load_config()),
    }


@router.post("/configure")
async def configure(body: ConfigureBody):
    if not is_private_host(body.baseUrl):
        raise HTTPException(status_code=400, detail="Base URL must be localhost or a private LAN IP.")
    cfg = {
        "baseUrl": body.baseUrl.rstrip("/"),
        "token": body.token,
        "appId": body.appId or "hermesdesktop01",
    }
    save_config(cfg)
    _ensure_bridge()
    return {"ok": True}


@router.get("/state")
async def get_state():
    cfg = load_config()
    if not cfg or not cfg.get("token"):
        raise HTTPException(status_code=401, detail="Not configured.")
    base = cfg["baseUrl"].rstrip("/")
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(f"{base}/api/v1/state", headers={"Authorization": cfg["token"]})
    if res.status_code >= 400:
        raise HTTPException(status_code=res.status_code, detail=res.text)
    data = res.json()
    _runtime["last_state"] = data
    return data


@router.post("/command")
async def command(body: CommandBody):
    cfg = load_config()
    if not cfg or not cfg.get("token"):
        raise HTTPException(status_code=401, detail="Not configured.")
    base = cfg["baseUrl"].rstrip("/")
    payload = {"command": body.command}
    if body.data is not None:
        payload["data"] = body.data
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.post(
            f"{base}/api/v1/command",
            headers={"Authorization": cfg["token"], "Content-Type": "application/json"},
            json=payload,
        )
    if res.status_code >= 400:
        raise HTTPException(status_code=res.status_code, detail=res.text)
    return {"ok": True}


@router.get("/playlists")
async def playlists():
    cfg = load_config()
    if not cfg or not cfg.get("token"):
        raise HTTPException(status_code=401, detail="Not configured.")
    base = cfg["baseUrl"].rstrip("/")
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.get(f"{base}/api/v1/playlists", headers={"Authorization": cfg["token"]})
    if res.status_code >= 400:
        raise HTTPException(status_code=res.status_code, detail=res.text)
    return res.json()

@router.get("/metadata")
async def metadata():
    cfg = load_config()
    base = (cfg["baseUrl"] if cfg else "http://localhost:9863").rstrip("/")
    async with httpx.AsyncClient(timeout=5) as client:
        try:
            res = await client.get(f"{base}/metadata")
            return res.json()
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc))
