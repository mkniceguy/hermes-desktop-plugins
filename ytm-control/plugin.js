/**
 * ytm-control — Hermes Desktop Plugin
 *
 * Controls YouTube Music Desktop App via its Companion Server API.
 * Shows now-playing info, playback controls, volume, and like/dislike.
 *
 * Auth: one-time flow — click Connect, approve in YT Music app, token persists.
 * Docs: https://github.com/ytmdesktop/ytmdesktop/wiki/v2-%E2%80%90-Companion-Server-API-v1
 */
import { Separator, useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API = 'http://localhost:9863/api/v1'
const AUTH = 'http://localhost:9863'
const APP_ID = 'hermesdesktop01'
const APP_NAME = 'Hermes Desktop'
const APP_VERSION = '1.0.0'
const POLL_MS = 3_000

// ---------------------------------------------------------------------------
// Module-level storage ref (set once in register)
// ---------------------------------------------------------------------------
let storage = null

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
function hdr(token) {
  const h = { 'Content-Type': 'application/json' }
  if (token) h['Authorization'] = token
  return h
}

async function requestCode() {
  const res = await fetch(`${API}/auth/requestcode`, {
    method: 'POST',
    headers: hdr(),
    body: JSON.stringify({ appId: APP_ID, appName: APP_NAME, appVersion: APP_VERSION }),
  })
  if (!res.ok) throw new Error(`Request code failed: ${res.status}`)
  return (await res.json()).code
}

async function requestToken(code) {
  const res = await fetch(`${API}/auth/request`, {
    method: 'POST',
    headers: hdr(),
    body: JSON.stringify({ appId: APP_ID, code }),
  })
  if (!res.ok) throw new Error(`Request token failed: ${res.status}`)
  return (await res.json()).token
}

async function getState(token) {
  const res = await fetch(`${API}/state`, { headers: hdr(token) })
  if (!res.ok) throw new Error(`Get state failed: ${res.status}`)
  return res.json()
}

async function cmd(token, command, data) {
  const body = { command }
  if (data !== undefined) body.data = data
  const res = await fetch(`${API}/command`, {
    method: 'POST',
    headers: hdr(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Command failed: ${res.status}`)
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function fmtTime(s) {
  if (!s || s < 0) return '0:00'
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------
function Header({ connected, title, artist }) {
  return jsx('div', {
    className: 'flex items-center gap-2 px-3 py-2 text-sm font-medium',
    children: jsxs('div', {
      className: 'flex items-center gap-2 min-w-0',
      children: [
        jsx('span', { children: 'YouTube Music' }),
        connected && title
          ? jsx('span', {
              className: 'ml-1 text-xs text-(--ui-text-tertiary) truncate',
              children: `— ${artist || ''}`,
            })
          : null,
      ],
    }),
  })
}

function AuthScreen({ onConnect, connecting, error }) {
  return jsxs('div', {
    className: 'flex flex-col items-center gap-3 px-3 py-6 text-sm',
    children: [
      jsx('div', {
        className: 'text-(--ui-text-tertiary) text-xs text-center',
        children: 'Connect to YouTube Music Desktop to control playback.',
      }),
      jsx('button', {
        type: 'button',
        onClick: onConnect,
        disabled: connecting,
        style: {
          padding: '6px 12px',
          fontSize: '12px',
          borderRadius: '6px',
          border: '1px solid var(--ui-stroke-secondary)',
          background: 'none',
          cursor: connecting ? 'wait' : 'pointer',
          color: 'var(--ui-text-secondary)',
          opacity: connecting ? 0.5 : 1,
        },
        children: connecting ? 'Waiting for approval…' : 'Connect to YouTube Music',
      }),
      connecting
        ? jsx('div', {
            className: 'text-xs text-(--ui-text-quaternary) text-center',
            children: 'Check the YouTube Music app — approve the connection request.',
          })
        : null,
      error
        ? jsx('div', {
            className: 'text-xs text-(--ui-text-quaternary) text-center',
            children: `Error: ${error}`,
          })
        : null,
    ],
  })
}

function NowPlaying({ video }) {
  if (!video) return null
  const thumb = video.thumbnails?.[0]?.url
  return jsxs('div', {
    className: 'flex gap-3 px-3 py-2',
    children: [
      thumb
        ? jsx('img', {
            src: thumb,
            alt: '',
            style: { width: '56px', height: '56px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 },
          })
        : jsx('div', {
            style: { width: '56px', height: '56px', borderRadius: '4px', backgroundColor: 'var(--ui-stroke-secondary)', flexShrink: 0 },
          }),
      jsxs('div', {
        className: 'min-w-0 flex flex-col justify-center gap-0.5',
        children: [
          jsx('div', { className: 'text-sm font-medium truncate', children: video.title || 'Unknown' }),
          jsx('div', { className: 'text-xs text-(--ui-text-tertiary) truncate', children: video.author || '' }),
          video.album
            ? jsx('div', { className: 'text-xs text-(--ui-text-quaternary) truncate', children: video.album })
            : null,
        ],
      }),
    ],
  })
}

function ProgressBar({ progress, duration }) {
  const pct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0
  return jsxs('div', {
    className: 'px-3 py-1 flex items-center gap-2 text-[10px] text-(--ui-text-quaternary)',
    children: [
      jsx('span', { children: fmtTime(progress) }),
      jsx('div', {
        style: { flex: 1, height: '3px', backgroundColor: 'var(--ui-stroke-secondary)', borderRadius: '2px', overflow: 'hidden' },
        children: jsx('div', {
          style: { width: `${pct}%`, height: '100%', backgroundColor: 'var(--ui-accent)', borderRadius: '2px', transition: 'width 0.3s ease' },
        }),
      }),
      jsx('span', { children: fmtTime(duration) }),
    ],
  })
}

function Controls({ token, player, queryClient }) {
  const trackState = player?.trackState ?? -1
  const isPlaying = trackState === 1
  const likeStatus = player?.video?.likeStatus ?? 0

  const run = (command, data) => {
    cmd(token, command, data).then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }

  const btn = (label, onClick, active) =>
    jsx('button', {
      type: 'button',
      onClick,
      style: {
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '4px 8px',
        fontSize: '16px',
        color: active ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)',
        lineHeight: 1,
      },
      children: label,
    })

  return jsxs('div', {
    className: 'flex items-center justify-center gap-1 px-3 py-2',
    children: [
      btn(likeStatus === 2 ? '♥' : '♡', () => run('toggleLike'), likeStatus === 2),
      btn('⏮', () => run('previous')),
      jsx('button', {
        type: 'button',
        onClick: () => run('playPause'),
        style: {
          background: 'none',
          border: '1px solid var(--ui-stroke-secondary)',
          borderRadius: '50%',
          cursor: 'pointer',
          padding: '6px 10px',
          fontSize: '16px',
          color: 'var(--ui-text-secondary)',
          lineHeight: 1,
        },
        children: isPlaying ? '⏸' : '▶',
      }),
      btn('⏭', () => run('next')),
      btn('👎', () => run('toggleDislike'), likeStatus === 0),
    ],
  })
}

function VolumeBar({ token, volume, queryClient }) {
  const setVol = (v) => {
    cmd(token, 'setVolume', v).then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }
  return jsxs('div', {
    className: 'flex items-center gap-2 px-3 py-1 text-xs',
    children: [
      jsx('span', {
        style: { cursor: 'pointer', fontSize: '12px', color: 'var(--ui-text-tertiary)' },
        onClick: () => cmd(token, 'mute').then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] })),
        children: '🔊',
      }),
      jsx('input', {
        type: 'range',
        min: 0,
        max: 100,
        value: volume ?? 50,
        onChange: (e) => setVol(Number(e.target.value)),
        style: { flex: 1, accentColor: 'var(--ui-accent)', height: '3px' },
      }),
      jsx('span', {
        className: 'text-(--ui-text-quaternary)',
        style: { width: '20px', textAlign: 'right' },
        children: String(volume ?? 0),
      }),
    ],
  })
}

// ---------------------------------------------------------------------------
// Main pane
// ---------------------------------------------------------------------------
function YtmPane() {
  const queryClient = useQueryClient()
  const [auth, setAuth] = useState(() => {
    const saved = storage?.get('token')
    return { connected: !!saved, token: saved || null, connecting: false, error: null }
  })

  const { data: state } = useQuery({
    queryKey: ['ytm', 'state'],
    queryFn: () => getState(auth.token),
    enabled: auth.connected && !!auth.token,
    refetchInterval: POLL_MS,
    retry: false,
    staleTime: Math.floor(POLL_MS / 2),
  })

  const handleConnect = async () => {
    setAuth((s) => ({ ...s, connecting: true, error: null }))
    try {
      const code = await requestCode()
      const token = await requestToken(code)
      storage?.set('token', token)
      setAuth({ connected: true, token, connecting: false, error: null })
    } catch (e) {
      setAuth((s) => ({ ...s, connecting: false, error: e.message }))
    }
  }

  const player = state?.player
  const video = state?.video

  return jsxs('div', {
    className: 'flex h-full flex-col text-sm',
    children: [
      jsx(Header, { connected: auth.connected, title: video?.title, artist: video?.author }),
      jsx(Separator, {}),
      !auth.connected
        ? jsx(AuthScreen, { onConnect: handleConnect, connecting: auth.connecting, error: auth.error })
        : jsxs('div', {
            className: 'flex flex-col',
            children: [
              jsx(NowPlaying, { video }),
              jsx(ProgressBar, { progress: player?.videoProgress ?? 0, duration: video?.durationSeconds ?? 0 }),
              jsx(Controls, { token: auth.token, player, queryClient }),
              jsx(VolumeBar, { token: auth.token, volume: player?.volume, queryClient }),
            ],
          }),
    ],
  })
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export default {
  id: 'ytm-control',
  name: 'YouTube Music Control',
  register(ctx) {
    storage = ctx.storage
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'youtube music',
      data: { placement: 'right', width: '300px' },
      render: () => jsx(YtmPane, {}),
    })
  },
}
