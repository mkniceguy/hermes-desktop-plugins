/**
 * ytm-control — Hermes Desktop Plugin
 *
 * Controls YouTube Music Desktop App via its Companion Server API.
 * Now-playing, seek, transport controls, like/dislike, volume.
 * Statusbar mini-chip for quick play/pause.
 *
 * Auth: one-time flow — click Connect, approve in YT Music app, token persists.
 */
import { Separator, useQuery, useQueryClient, host, haptic } from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API = 'http://localhost:9863/api/v1'
const APP_ID = 'hermesdesktop01'
const APP_NAME = 'Hermes Desktop'
const APP_VERSION = '1.0.0'
const POLL_MS = 3_000

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
// SVG icons — stroke style, currentColor, 16px viewBox 24
// ---------------------------------------------------------------------------
function Icon({ d, filled, size = 16 }) {
  return jsx('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: filled ? 'currentColor' : 'none',
    stroke: 'currentColor',
    strokeWidth: filled ? 0 : 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { display: 'block' },
    children: jsx('path', { d }),
  })
}

const I = {
  play: 'M7 4.5v15l13-7.5-13-7.5z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  prev: 'M19 20L9 12l10-8v16zM7 4H5v16h2V4z',
  next: 'M5 4l10 8-10 8V4zM17 4h2v16h-2V4z',
  heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  thumbUp: 'M7 22V11H2v11h5zm2 0h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 2 7.59 8.59C7.22 8.95 7 9.45 7 10v10c0 1.1.9 2 2 2z',
  thumbDown: 'M17 2v11h5V2h-5zm-2 0H6c-.83 0-1.54.5-1.84 1.22L1.14 10.27c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 22l6.59-6.59c.36-.36.58-.86.58-1.41V4c0-1.1-.9-2-2-2z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function fmtTime(s) {
  if (!s || s < 0) return '0:00'
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Shared button renderer
// ---------------------------------------------------------------------------
function IconBtn({ icon, onClick, active, size = 16, pad = 6, circle }) {
  return jsx('button', {
    type: 'button',
    onClick: () => { haptic('tap'); onClick() },
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'none',
      border: circle ? '1px solid var(--ui-stroke-secondary)' : 'none',
      borderRadius: circle ? '50%' : '6px',
      cursor: 'pointer',
      padding: `${pad}px`,
      color: active ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)',
      transition: 'color 120ms ease, background 120ms ease',
    },
    onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--ui-surface-secondary, rgba(127,127,127,0.08))' },
    onMouseLeave: (e) => { e.currentTarget.style.background = 'none' },
    children: jsx(Icon, { d: icon, filled: active, size }),
  })
}

// ---------------------------------------------------------------------------
// Pane components
// ---------------------------------------------------------------------------
function Header({ connected, artist, onDisconnect }) {
  return jsxs('div', {
    className: 'flex items-center gap-2 px-3 py-2 text-sm font-medium',
    children: [
      jsx('span', { children: 'YouTube Music' }),
      connected && artist
        ? jsx('span', {
            className: 'text-xs text-(--ui-text-tertiary) truncate flex-1',
            children: `— ${artist}`,
          })
        : jsx('span', { className: 'flex-1' }),
      connected
        ? jsx('button', {
            type: 'button',
            onClick: onDisconnect,
            title: 'Disconnect',
            style: {
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '10px',
              color: 'var(--ui-text-quaternary)',
              padding: '2px 4px',
            },
            children: 'disconnect',
          })
        : null,
    ],
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

// Seek slider — was a display-only bar
function SeekBar({ token, progress, duration, queryClient }) {
  const seek = (sec) => {
    cmd(token, 'seekTo', sec).then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }
  return jsxs('div', {
    className: 'px-3 py-1 flex items-center gap-2 text-[10px] text-(--ui-text-quaternary)',
    children: [
      jsx('span', { children: fmtTime(progress) }),
      jsx('input', {
        type: 'range',
        min: 0,
        max: Math.floor(duration || 0),
        value: Math.floor(progress || 0),
        onChange: (e) => seek(Number(e.target.value)),
        disabled: !duration,
        style: { flex: 1, accentColor: 'var(--ui-accent)', height: '3px', cursor: duration ? 'pointer' : 'default' },
      }),
      jsx('span', { children: fmtTime(duration) }),
    ],
  })
}

// Transport row: prev / play-pause (circle) / next
function Transport({ token, player, queryClient }) {
  const isPlaying = (player?.trackState ?? -1) === 1
  const run = (command, data) => {
    cmd(token, command, data).then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }
  return jsxs('div', {
    className: 'flex items-center justify-center gap-2 px-3 pt-2',
    children: [
      jsx(IconBtn, { icon: I.prev, onClick: () => run('previous'), size: 18 }),
      jsx(IconBtn, {
        icon: isPlaying ? I.pause : I.play,
        onClick: () => run('playPause'),
        size: 20,
        pad: 10,
        circle: true,
        filled: true,
      }),
      jsx(IconBtn, { icon: I.next, onClick: () => run('next'), size: 18 }),
    ],
  })
}

// Like / dislike pill — side-by-side, constant up+down pair
// NOTE: likeStatus lives on the top-level `video` object, not on `player`.
function RatePill({ token, video, queryClient }) {
  const likeStatus = video?.likeStatus ?? -1
  const run = (command) => {
    cmd(token, command).then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }
  return jsxs('div', {
    className: 'flex items-center justify-center gap-2 px-3 pb-2 pt-1',
    children: [
      jsxs('div', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          border: '1px solid var(--ui-stroke-secondary)',
          borderRadius: '999px',
          overflow: 'hidden',
        },
        children: [
          jsx('div', {
            style: { padding: '4px 12px', display: 'flex' },
            children: jsx(IconBtn, {
              icon: I.thumbUp,
              onClick: () => run('toggleLike'),
              active: likeStatus === 2,
              size: 14,
              pad: 2,
            }),
          }),
          jsx('div', { style: { width: '1px', alignSelf: 'stretch', backgroundColor: 'var(--ui-stroke-secondary)' } }),
          jsx('div', {
            style: { padding: '4px 12px', display: 'flex' },
            children: jsx(IconBtn, {
              icon: I.thumbDown,
              onClick: () => run('toggleDislike'),
              active: likeStatus === 0,
              size: 14,
              pad: 2,
            }),
          }),
        ],
      }),
      jsx('span', {
        className: 'text-(--ui-text-quaternary)',
        style: { fontSize: '9px' },
        title: 'raw likeStatus (debug)',
        children: `[${likeStatus}]`,
      }),
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
      jsx(IconBtn, { icon: I.volume, onClick: () => cmd(token, 'mute').then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] })), size: 14, pad: 2 }),
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

  const handleDisconnect = () => {
    storage?.remove('token')
    setAuth({ connected: false, token: null, connecting: false, error: null })
  }

  const player = state?.player
  const video = state?.video

  return jsxs('div', {
    className: 'flex h-full flex-col text-sm',
    children: [
      jsx(Header, { connected: auth.connected, artist: video?.author, onDisconnect: handleDisconnect }),
      jsx(Separator, {}),
      !auth.connected
        ? jsx(AuthScreen, { onConnect: handleConnect, connecting: auth.connecting, error: auth.error })
        : jsxs('div', {
            className: 'flex flex-col',
            children: [
              jsx(NowPlaying, { video }),
              jsx(SeekBar, { token: auth.token, progress: player?.videoProgress ?? 0, duration: video?.durationSeconds ?? 0, queryClient }),
              jsx(Transport, { token: auth.token, player, queryClient }),
              jsx(RatePill, { token: auth.token, video, queryClient }),
              jsx(VolumeBar, { token: auth.token, volume: player?.volume, queryClient }),
            ],
          }),
    ],
  })
}

// ---------------------------------------------------------------------------
// Statusbar mini-chip — play/pause + track title
// ---------------------------------------------------------------------------
function StatusChip() {
  const queryClient = useQueryClient()
  const token = storage?.get('token')
  const { data: state } = useQuery({
    queryKey: ['ytm', 'state'],
    queryFn: () => getState(token),
    enabled: !!token,
    refetchInterval: POLL_MS,
    retry: false,
    staleTime: Math.floor(POLL_MS / 2),
  })
  if (!token) return null
  const player = state?.player
  const video = state?.video
  const isPlaying = (player?.trackState ?? -1) === 1
  const title = video?.title
  if (!title) return null

  const toggle = () => {
    cmd(token, 'playPause').then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }

  return jsxs('button', {
    type: 'button',
    onClick: () => { haptic('tap'); toggle() },
    title: `${isPlaying ? 'Pause' : 'Play'} — ${title}`,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '0 6px',
      fontSize: '0.6875rem',
      color: 'var(--ui-text-tertiary)',
      maxWidth: '220px',
    },
    children: [
      jsx(Icon, { d: isPlaying ? I.pause : I.play, filled: true, size: 10 }),
      jsx('span', {
        style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        children: title,
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
    ctx.registerMany([
      {
        id: 'pane',
        area: 'panes',
        title: 'youtube music',
        data: { placement: 'right', width: '300px' },
        render: () => jsx(YtmPane, {}),
      },
      {
        id: 'chip',
        area: 'statusBar.right',
        order: 131,
        render: () => jsx(StatusChip, {}),
      },
    ])
  },
}
