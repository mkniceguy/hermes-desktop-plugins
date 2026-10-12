/**
 * ytm-control — Hermes Desktop Plugin
 *
 * Controls YouTube Music Desktop App via its Companion Server API.
 * Now-playing, seek, transport controls, like/dislike, volume.
 * Statusbar mini-chip for quick play/pause.
 *
 * v0.2 — release polish:
 *  - Configurable Companion Server URL (settings form, save & test)
 *  - Explicit loading / offline / error states
 *  - Auth flow polls for approval with a timeout and shows the code
 *  - Debounced seek, no mid-drag jumps
 *  - Accessible labels; debug readout removed
 *
 * Auth: one-time flow — click Connect, approve in YT Music app, token persists.
 */
import { Separator, useQuery, useQueryClient, host, haptic } from '@hermes/plugin-sdk'
import { useState, useEffect, useRef } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const DEFAULT_BASE = 'http://localhost:9863'
const APP_NAME = 'Hermes Desktop'
const APP_VERSION = '0.2.0'
const POLL_MS = 3_000
const AUTH_TIMEOUT_MS = 90_000

let storage = null

function cfg() {
  const raw = (storage?.get('baseUrl') || DEFAULT_BASE).trim()
  return {
    baseUrl: raw.replace(/\/+$/, '') || DEFAULT_BASE,
    appId: (storage?.get('appId') || 'hermesdesktop01').trim() || 'hermesdesktop01',
  }
}

function apiUrl(path) {
  return `${cfg().baseUrl}/api/v1${path}`
}

function hdr(token) {
  const h = { 'Content-Type': 'application/json' }
  if (token) h['Authorization'] = token
  return h
}

async function requestCode() {
  const { appId } = cfg()
  const res = await fetch(apiUrl('/auth/requestcode'), {
    method: 'POST',
    headers: hdr(),
    body: JSON.stringify({ appId, appName: APP_NAME, appVersion: APP_VERSION }),
  })
  if (!res.ok) throw new Error(`Request code failed: ${res.status}`)
  const json = await res.json()
  if (!json?.code) throw new Error('No code returned by Companion Server')
  return json.code
}

async function requestToken(code) {
  const { appId } = cfg()
  const res = await fetch(apiUrl('/auth/request'), {
    method: 'POST',
    headers: hdr(),
    body: JSON.stringify({ appId, code }),
  })
  if (res.status === 408 || res.status === 425 || res.status === 400) return null
  if (!res.ok) throw new Error(`Request token failed: ${res.status}`)
  const json = await res.json()
  return json?.token || null
}

async function pollToken(code, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || AUTH_TIMEOUT_MS)
  while (Date.now() < deadline) {
    const token = await requestToken(code)
    if (token) return token
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('Timed out waiting for approval in YouTube Music Desktop.')
}

async function getState(token) {
  const res = await fetch(apiUrl('/state'), { headers: hdr(token) })
  if (!res.ok) throw new Error(`Get state failed: ${res.status}`)
  return res.json()
}

async function cmd(token, command, data) {
  const body = { command }
  if (data !== undefined) body.data = data
  const res = await fetch(apiUrl('/command'), {
    method: 'POST',
    headers: hdr(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Command failed: ${res.status}`)
}

async function testConnection(url) {
  const base = url.replace(/\/+$/, '')
  const res = await fetch(`${base}/api/v1/state`, { headers: hdr() })
  if (res.status === 404 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
  return true
}

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
    'aria-hidden': 'true',
    children: jsx('path', { d }),
  })
}

const I = {
  play: 'M7 4.5v15l13-7.5-13-7.5z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  prev: 'M19 20L9 12l10-8v16zM7 4H5v16h2V4z',
  next: 'M5 4l10 8-10 8V4zM17 4h2v16h-2V4z',
  thumbUp: 'M7 22V11H2v11h5zm2 0h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 2 7.59 8.59C7.22 8.95 7 9.45 7 10v10c0 1.1.9 2 2 2z',
  thumbDown: 'M17 2v11h5V2h-5zm-2 0H6c-.83 0-1.54.5-1.84 1.22L1.14 10.27c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 22l6.59-6.59c.36-.36.58-.86.58-1.41V4c0-1.1-.9-2-2-2z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3.06a1.5 1.5 0 0 0-.64-2.5l-1.1-.22a7.97 7.97 0 0 0-.56-1.36l.63-.94a1.5 1.5 0 0 0-.19-1.9l-.85-.85a1.5 1.5 0 0 0-1.9-.19l-.94.63c-.44-.22-.9-.4-1.36-.56l-.22-1.1a1.5 1.5 0 0 0-2.5-.64h-1.2a1.5 1.5 0 0 0-2.5.64l-.22 1.1c-.46.16-.92.34-1.36.56l-.94-.63a1.5 1.5 0 0 0-1.9.19l-.85.85a1.5 1.5 0 0 0-.19 1.9l.63.94c-.22.44-.4.9-.56 1.36l-1.1.22a1.5 1.5 0 0 0-.64 2.5v1.2a1.5 1.5 0 0 0 .64 2.5l1.1.22c.16.46.34.92.56 1.36l-.63.94a1.5 1.5 0 0 0 .19 1.9l.85.85a1.5 1.5 0 0 0 1.9.19l.94-.63c.44.22.9.4 1.36.56l.22 1.1a1.5 1.5 0 0 0 2.5.64h1.2a1.5 1.5 0 0 0 2.5-.64l.22-1.1c.46-.16.92-.34 1.36-.56l.94.63a1.5 1.5 0 0 0 1.9-.19l.85-.85a1.5 1.5 0 0 0 .19-1.9l-.63-.94c.22-.44.4-.9.56-1.36l1.1-.22a1.5 1.5 0 0 0 .64-2.5v-1.2z',
}

function fmtTime(s) {
  if (!s || s < 0) return '0:00'
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}

const inputStyle = {
  width: '100%',
  padding: '5px 8px',
  fontSize: '12px',
  borderRadius: '6px',
  border: '1px solid var(--ui-stroke-secondary)',
  background: 'none',
  color: 'var(--ui-text-secondary)',
  outline: 'none',
  boxSizing: 'border-box',
}

function IconBtn({ icon, onClick, active, size = 16, pad = 6, circle, disabled, label }) {
  return jsx('button', {
    type: 'button',
    'aria-label': label,
    title: label,
    disabled: !!disabled,
    onClick: () => { if (disabled) return; haptic('tap'); onClick() },
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'none',
      border: circle ? '1px solid var(--ui-stroke-secondary)' : 'none',
      borderRadius: circle ? '50%' : '6px',
      cursor: disabled ? 'not-allowed' : 'pointer',
      padding: `${pad}px`,
      color: active ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)',
      opacity: disabled ? 0.4 : 1,
      transition: 'color 120ms ease, background 120ms ease',
    },
    onMouseEnter: (e) => { if (!disabled) e.currentTarget.style.background = 'var(--ui-surface-secondary, rgba(127,127,127,0.08))' },
    onMouseLeave: (e) => { e.currentTarget.style.background = 'none' },
    children: jsx(Icon, { d: icon, filled: active, size }),
  })
}

function Header({ connected, artist, onDisconnect, onSettings }) {
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
            'aria-label': 'Disconnect from YouTube Music',
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
      jsx(IconBtn, { icon: I.settings, onClick: onSettings, size: 14, pad: 2, label: 'Settings' }),
    ],
  })
}

function SettingsForm({ initial, onSave, onCancel, saving, error }) {
  const [url, setUrl] = useState(initial.url)
  const [appId, setAppId] = useState(initial.appId)
  return jsxs('div', {
    className: 'flex flex-col gap-2 px-3 py-3 text-xs',
    children: [
      jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Companion Server connection' }),
      jsx('input', {
        type: 'text',
        placeholder: 'URL — http://localhost:9863',
        value: url,
        onChange: (e) => setUrl(e.target.value),
        style: inputStyle,
      }),
      jsx('input', {
        type: 'text',
        placeholder: 'App ID — hermesdesktop01',
        value: appId,
        onChange: (e) => setAppId(e.target.value),
        style: inputStyle,
      }),
      jsx('div', {
        className: 'text-(--ui-text-quaternary)',
        style: { fontSize: '10px' },
        children: 'Enable in YT Music Desktop: Settings → Integrations → Companion Server.',
      }),
      error ? jsx('div', { style: { color: '#f59e0b', fontSize: '11px' }, children: error }) : null,
      jsxs('div', {
        className: 'flex gap-2',
        children: [
          jsx('button', {
            type: 'button',
            disabled: saving || !url.trim(),
            onClick: () => onSave(url.trim(), appId.trim()),
            style: {
              padding: '5px 12px',
              fontSize: '12px',
              borderRadius: '6px',
              border: '1px solid var(--ui-stroke-secondary)',
              background: 'none',
              cursor: saving ? 'wait' : 'pointer',
              color: 'var(--ui-text-secondary)',
              opacity: saving || !url.trim() ? 0.5 : 1,
            },
            children: saving ? 'Testing…' : 'Save & test',
          }),
          (initial.url && initial.url !== '')
            ? jsx('button', {
                type: 'button',
                onClick: onCancel,
                style: { padding: '5px 12px', fontSize: '12px', borderRadius: '6px', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ui-text-quaternary)' },
                children: 'Cancel',
              })
            : null,
        ],
      }),
    ],
  })
}

function AuthScreen({ onConnect, connecting, code, error }) {
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
        ? jsxs('div', {
            className: 'text-xs text-(--ui-text-quaternary) text-center',
            children: [
              'Check the YouTube Music app — approve the connection request.',
              code ? jsx('div', { style: { marginTop: '4px', fontFamily: 'monospace' }, children: `Code: ${code}` }) : null,
            ],
          })
        : null,
      error
        ? jsx('div', { className: 'text-xs', style: { color: '#f59e0b', textAlign: 'center' }, children: `Error: ${error}` })
        : null,
    ],
  })
}

function NowPlaying({ video, loading }) {
  if (loading) {
    return jsxs('div', {
      className: 'flex gap-3 px-3 py-2',
      children: [
        jsx('div', { style: { width: '56px', height: '56px', borderRadius: '4px', backgroundColor: 'var(--ui-stroke-secondary)', flexShrink: 0 } }),
        jsxs('div', {
          className: 'min-w-0 flex flex-col justify-center gap-1 flex-1',
          children: [
            jsx('div', { style: { height: '12px', width: '70%', borderRadius: '3px', backgroundColor: 'var(--ui-stroke-secondary)' } }),
            jsx('div', { style: { height: '10px', width: '50%', borderRadius: '3px', backgroundColor: 'var(--ui-stroke-secondary)' } }),
            jsx('div', { style: { height: '10px', width: '40%', borderRadius: '3px', backgroundColor: 'var(--ui-stroke-secondary)' } }),
          ],
        }),
      ],
    })
  }
  if (!video) return null
  const thumb = video.thumbnails?.[0]?.url
  return jsxs('div', {
    className: 'flex gap-3 px-3 py-2',
    children: [
      thumb
        ? jsx('img', {
            src: thumb,
            alt: video.title ? `${video.title} cover` : '',
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

function SeekBar({ token, progress, duration, queryClient }) {
  const [dragging, setDragging] = useState(false)
  const [local, setLocal] = useState(Math.floor(progress || 0))

  useEffect(() => {
    if (!dragging) setLocal(Math.floor(progress || 0))
  }, [progress, dragging])

  const commit = (sec) => {
    cmd(token, 'seekTo', sec).then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }

  return jsxs('div', {
    className: 'px-3 py-1 flex items-center gap-2 text-[10px] text-(--ui-text-quaternary)',
    children: [
      jsx('span', { children: fmtTime(dragging ? local : progress) }),
      jsx('input', {
        type: 'range',
        min: 0,
        max: Math.floor(duration || 0),
        value: dragging ? local : Math.floor(progress || 0),
        disabled: !duration,
        'aria-label': 'Seek position',
        onPointerDown: () => setDragging(true),
        onPointerUp: () => { setDragging(false); commit(local) },
        onTouchEnd: () => { setDragging(false); commit(local) },
        onChange: (e) => setLocal(Number(e.target.value)),
        onKeyDown: (e) => { if (e.key === 'Enter') { setDragging(false); commit(local) } },
        style: { flex: 1, accentColor: 'var(--ui-accent)', height: '3px', cursor: duration ? 'pointer' : 'default' },
      }),
      jsx('span', { children: fmtTime(duration) }),
    ],
  })
}

function Transport({ token, player, queryClient }) {
  const isPlaying = (player?.trackState ?? -1) === 1
  const run = (command, data) => {
    cmd(token, command, data).then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }
  return jsxs('div', {
    className: 'flex items-center justify-center gap-2 px-3 pt-2',
    children: [
      jsx(IconBtn, { icon: I.prev, onClick: () => run('previous'), size: 18, label: 'Previous track' }),
      jsx(IconBtn, {
        icon: isPlaying ? I.pause : I.play,
        onClick: () => run('playPause'),
        size: 20,
        pad: 10,
        circle: true,
        filled: true,
        label: isPlaying ? 'Pause' : 'Play',
      }),
      jsx(IconBtn, { icon: I.next, onClick: () => run('next'), size: 18, label: 'Next track' }),
    ],
  })
}

function RatePill({ token, video, queryClient }) {
  const likeStatus = video?.likeStatus ?? -1
  const run = (command) => {
    cmd(token, command).then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }
  return jsx('div', {
    className: 'flex items-center justify-center gap-2 px-3 pb-2 pt-1',
    children: jsx('div', {
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
            label: 'Like',
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
            label: 'Dislike',
          }),
        }),
      ],
    }),
  })
}

function VolumeBar({ token, volume, queryClient }) {
  const [local, setLocal] = useState(volume ?? 50)
  useEffect(() => { setLocal(volume ?? 50) }, [volume])
  const setVol = (v) => {
    setLocal(v)
    cmd(token, 'setVolume', v).then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }
  return jsxs('div', {
    className: 'flex items-center gap-2 px-3 py-1 text-xs',
    children: [
      IconBtn({ icon: I.volume, onClick: () => cmd(token, 'mute').then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] })), size: 14, pad: 2, label: 'Mute' }),
      jsx('input', {
        type: 'range',
        min: 0,
        max: 100,
        value: local,
        'aria-label': 'Volume',
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

function YtmPane() {
  const queryClient = useQueryClient()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [settingsError, setSettingsError] = useState(null)
  const [auth, setAuth] = useState(() => {
    const saved = storage?.get('token')
    return { connected: !!saved, token: saved || null, connecting: false, code: null, error: null }
  })

  const c = cfg()
  const { data: state, error: stateError, isFetching } = useQuery({
    queryKey: ['ytm', 'state', auth.token, c.baseUrl],
    queryFn: () => getState(auth.token),
    enabled: auth.connected && !!auth.token,
    refetchInterval: POLL_MS,
    retry: 1,
    staleTime: Math.floor(POLL_MS / 2),
  })

  const offline = !!stateError
  const player = state?.player
  const video = state?.video

  const handleConnect = async () => {
    setAuth((s) => ({ ...s, connecting: true, error: null, code: null }))
    try {
      const code = await requestCode()
      setAuth((s) => ({ ...s, code }))
      const token = await pollToken(code, AUTH_TIMEOUT_MS)
      storage?.set('token', token)
      setAuth({ connected: true, token, connecting: false, code: null, error: null })
    } catch (e) {
      setAuth((s) => ({ ...s, connecting: false, code: null, error: e?.message || String(e) }))
    }
  }

  const handleDisconnect = () => {
    storage?.remove('token')
    setAuth({ connected: false, token: null, connecting: false, code: null, error: null })
  }

  const handleSaveSettings = async (url, appId) => {
    setSaving(true)
    setSettingsError(null)
    try {
      await testConnection(url)
      storage?.set('baseUrl', url)
      if (appId) storage?.set('appId', appId)
      setSettingsOpen(false)
    } catch (e) {
      setSettingsError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return jsxs('div', {
    className: 'flex h-full flex-col text-sm',
    children: [
      jsx(Header, {
        connected: auth.connected,
        artist: video?.author,
        onDisconnect: handleDisconnect,
        onSettings: () => setSettingsOpen((v) => !v),
      }),
      jsx(Separator, {}),
      settingsOpen
        ? jsx(SettingsForm, {
            initial: { url: c.baseUrl, appId: c.appId },
            onSave: handleSaveSettings,
            onCancel: () => setSettingsOpen(false),
            saving,
            error: settingsError,
          })
        : null,
      settingsOpen ? jsx(Separator, {}) : null,
      !auth.connected
        ? jsx(AuthScreen, {
            onConnect: handleConnect,
            connecting: auth.connecting,
            code: auth.code,
            error: auth.error,
          })
        : offline
        ? jsxs('div', {
            className: 'flex flex-col items-center gap-2 px-3 py-6 text-xs text-center',
            children: [
              jsx('div', { style: { color: '#f59e0b' }, children: 'Cannot reach the Companion Server.' }),
              jsx('div', {
                className: 'text-(--ui-text-quaternary)',
                children: `Check YT Music Desktop is running and the Companion Server is enabled at ${c.baseUrl}.`,
              }),
              stateError?.message
                ? jsx('div', { className: 'text-(--ui-text-quaternary)', style: { fontFamily: 'monospace', fontSize: '10px' }, children: stateError.message })
                : null,
            ],
          })
        : jsxs('div', {
            className: 'flex flex-col',
            children: [
              jsx(NowPlaying, { video, loading: isFetching && !state }),
              jsx(SeekBar, { token: auth.token, progress: player?.videoProgress ?? 0, duration: video?.durationSeconds ?? 0, queryClient }),
              jsx(Transport, { token: auth.token, player, queryClient }),
              jsx(RatePill, { token: auth.token, video, queryClient }),
              jsx(VolumeBar, { token: auth.token, volume: player?.volume, queryClient }),
            ],
          }),
    ],
  })
}

function StatusChip() {
  const queryClient = useQueryClient()
  const token = storage?.get('token')
  const c = cfg()
  const { data: state } = useQuery({
    queryKey: ['ytm', 'state', token, c.baseUrl],
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
    'aria-label': `${isPlaying ? 'Pause' : 'Play'} ${title}`,
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

export default {
  id: 'ytm-control',
  name: 'YouTube Music Control',
  version: '0.2.0',
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
