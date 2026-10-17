/**
 * ytm-control — Hermes Desktop plugin (v0.4.1)
 *
 * Controls the YouTube Music Desktop App through its Companion Server API.
 * Right-side pane: now-playing, seek, transport, repeat/shuffle, like/dislike,
 * volume, collapsible queue, playlist browser. Statusbar mini-chip for quick
 * play/pause with the pane closed.
 *
 * ARCHITECTURE (v0.4.1)
 * ---------------------
 * This half is presentation only. Every byte of state and every command goes
 * through the plugin's own backend namespace — /api/plugins/ytm-control/ — via
 * `ctx.rest`, and every live update arrives as a pushed event via
 * `host.onEvent`. The renderer NEVER talks to the Companion Server directly.
 *
 * That is the whole point of the 0.4.1 rework. In v0.4 this file contained a
 * second, parallel data path (`fetch` straight at ${baseUrl}/api/v1/…) that ran
 * alongside the backend one. Consequences: most backend routes were dead code,
 * and the private-LAN URL guard was unenforceable because the renderer simply
 * fetched the host itself. The backend now owns the token, the address
 * validation, and the Socket.IO connection; there is one data path.
 *
 * Auth is a one-time flow: press Connect, a code is shown, approve it inside
 * YT Music Desktop, and the backend stores the token from then on.
 */
import { Separator, useQuery, useQueryClient, host, haptic } from '@hermes/plugin-sdk'
import { useState, useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const APP_VERSION = '0.4.2'
const DEFAULT_BASE = 'http://127.0.0.1:9863'
const CONFIG_KEY = ['ytm', 'config']

let pluginCtx = null

// ---------------------------------------------------------------------------
// Backend calls — one data path, scoped to this plugin by construction
// ---------------------------------------------------------------------------

function rest(path, opts) {
  if (!pluginCtx) throw new Error('The ytm-control backend is not loaded.')
  return pluginCtx.rest(path, opts)
}

const getConfig = () => rest('/config')
const saveConfig = (body) => rest('/configure', { method: 'POST', body })
const probeServer = () => rest('/probe')
const getHealth = () => rest('/health')
const requestCode = () => rest('/auth/requestcode', { method: 'POST', body: {} })
// The Companion Server blocks this call for up to 30 s while the user approves,
// so the request needs a timeout well above the backend's own 45 s ceiling.
const requestToken = (code) => rest('/auth/request', { method: 'POST', body: { code }, timeoutMs: 60000 })
const forgetAuth = () => rest('/auth', { method: 'DELETE' })
const getState = () => rest('/state')
const getPlaylists = () => rest('/playlists')
const sendCommand = (command, data) =>
  rest('/command', { method: 'POST', body: data === undefined ? { command } : { command, data } })

function errText(e) {
  const raw = e?.message || String(e)
  return raw.replace(/^Error:\s*/, '')
}

/**
 * Live updates. The backend pushes `plugin.ytm-control.<event>` onto the app's
 * global event stream; this hooks that stream and refreshes the shared query
 * cache. (v0.4 used ctx.socket('/events'), which is this plugin's *own* backend
 * socket namespace — an endpoint that did not exist — so pushes never landed.)
 */
function useYtmEvents() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const invalidateState = () => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] })
    const invalidatePlaylists = () => queryClient.invalidateQueries({ queryKey: ['ytm', 'playlists'] })
    const disposers = [
      host.onEvent('plugin.ytm-control.state.updated', invalidateState),
      host.onEvent('plugin.ytm-control.connection.changed', invalidateState),
      host.onEvent('plugin.ytm-control.playlists.changed', invalidatePlaylists),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (e) {}
      }
    }
  }, [queryClient])
}

function useYtmConfig() {
  return useQuery({
    queryKey: CONFIG_KEY,
    queryFn: getConfig,
    staleTime: 10_000,
    retry: 1,
  })
}

function useYtmState(baseUrl, enabled, refetchInterval) {
  return useQuery({
    queryKey: ['ytm', 'state', baseUrl || 'default'],
    queryFn: getState,
    enabled,
    // Realtime pushes drive the UI; this interval is only a safety net for a
    // dropped socket, and the backend throttles its upstream /state calls to
    // the Companion Server's documented 1-per-5s budget regardless.
    refetchInterval,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    staleTime: 5_000,
  })
}

// ---------------------------------------------------------------------------
// Icons
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
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  shuffle: 'M16 3h5v5M4 20L21 3M21 16v5h-5M4 4l5 5',
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

function IconBtn({ icon, onClick, active, size = 16, pad = 6, circle, disabled, label, filled }) {
  return jsx('button', {
    type: 'button',
    'aria-label': label,
    title: label,
    disabled: !!disabled,
    onClick: () => {
      if (disabled) return
      haptic('tap')
      onClick()
    },
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
    onMouseEnter: (e) => {
      if (!disabled) e.currentTarget.style.background = 'var(--ui-surface-secondary, rgba(127,127,127,0.08))'
    },
    onMouseLeave: (e) => {
      e.currentTarget.style.background = 'none'
    },
    children: jsx(Icon, { d: icon, filled: (filled ?? true) ? active : false, size }),
  })
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function Header({ connected, artist, onDisconnect, onSettings }) {
  const right = connected
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
    : null
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
      right,
      jsx(IconBtn, { icon: I.settings, onClick: onSettings, size: 14, pad: 2, label: 'Settings' }),
    ],
  })
}

function Notice({ title, detail, mono }) {
  return jsxs('div', {
    className: 'flex flex-col items-center gap-2 px-3 py-6 text-xs text-center',
    children: [
      jsx('div', { style: { color: '#f59e0b' }, children: title }),
      detail ? jsx('div', { className: 'text-(--ui-text-quaternary)', children: detail }) : null,
      mono
        ? jsx('div', {
            className: 'text-(--ui-text-quaternary)',
            style: { fontFamily: 'monospace', fontSize: '10px' },
            children: mono,
          })
        : null,
    ],
  })
}

function SettingsForm({ initial, onSave, onCancel, saving, error }) {
  const [url, setUrl] = useState(initial.url)
  const [appId, setAppId] = useState(initial.appId)
  const { data: health } = useQuery({
    queryKey: ['ytm', 'health'],
    queryFn: getHealth,
    staleTime: 15_000,
    retry: 1,
  })
  const diagnostics = health
    ? `backend ${health.version} · realtime ${health.realtime ? (health.bridge?.connected ? 'connected' : 'idle') : 'unavailable'}`
    : null
  return jsxs('div', {
    className: 'flex flex-col gap-2 px-3 py-3 text-xs',
    children: [
      jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Companion Server connection' }),
      jsx('input', {
        type: 'text',
        placeholder: `URL — ${DEFAULT_BASE}`,
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
        children:
          'Enable in YT Music Desktop: Settings → Integrations → Companion Server. localhost is pinned to 127.0.0.1 (the server does not listen on IPv6).',
      }),
      diagnostics
        ? jsx('div', { className: 'text-(--ui-text-quaternary)', style: { fontSize: '10px' }, children: diagnostics })
        : null,
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
          jsx('button', {
            type: 'button',
            onClick: onCancel,
            style: {
              padding: '5px 12px',
              fontSize: '12px',
              borderRadius: '6px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: 'var(--ui-text-quaternary)',
            },
            children: 'Cancel',
          }),
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
              'Approve the request in the YouTube Music app.',
              code
                ? jsx('div', { style: { marginTop: '4px', fontFamily: 'monospace' }, children: `Code: ${code}` })
                : null,
            ],
          })
        : null,
      error
        ? jsx('div', {
            className: 'text-xs',
            style: { color: '#f59e0b', textAlign: 'center' },
            children: errText(error),
          })
        : null,
    ],
  })
}

// ---------------------------------------------------------------------------
// Playback UI
// ---------------------------------------------------------------------------

function NowPlaying({ video, loading }) {
  if (loading) {
    return jsxs('div', {
      className: 'flex gap-3 px-3 py-2',
      children: [
        jsx('div', {
          style: { width: '56px', height: '56px', borderRadius: '4px', backgroundColor: 'var(--ui-stroke-secondary)', flexShrink: 0 },
        }),
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

function SeekBar({ progress, duration, run }) {
  const [dragging, setDragging] = useState(false)
  const [local, setLocal] = useState(Math.floor(progress || 0))

  useEffect(() => {
    if (!dragging) setLocal(Math.floor(progress || 0))
  }, [progress, dragging])

  const commit = (sec) => {
    run('seekTo', sec)
    setDragging(false)
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
        onPointerUp: () => commit(local),
        onKeyDown: (e) => {
          if (e.key === 'Enter') commit(local)
        },
        onChange: (e) => setLocal(Number(e.target.value)),
        style: { flex: 1, accentColor: 'var(--ui-accent)', height: '3px', cursor: duration ? 'pointer' : 'default' },
      }),
      jsx('span', { children: fmtTime(duration) }),
    ],
  })
}

function Transport({ player, run }) {
  const isPlaying = (player?.trackState ?? -1) === 1
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

function ExtraControls({ state, run }) {
  const repeatMode = state?.player?.queue?.repeatMode ?? 0
  const [shuffled, setShuffled] = useState(false)
  const cycleRepeat = () => run('repeatMode', repeatMode >= 2 ? 0 : repeatMode + 1)
  const repeatLabel = repeatMode === 2 ? 'Repeat: one' : repeatMode === 1 ? 'Repeat: all' : 'Repeat: off'
  return jsxs('div', {
    className: 'flex items-center justify-center gap-2 px-3 pt-1',
    children: [
      jsx(IconBtn, { icon: I.repeat, onClick: cycleRepeat, active: repeatMode > 0, size: 14, pad: 4, label: repeatLabel }),
      jsx(IconBtn, {
        icon: I.shuffle,
        onClick: () => {
          setShuffled((v) => !v)
          run('shuffle')
        },
        active: shuffled,
        filled: false,
        size: 14,
        pad: 4,
        label: 'Shuffle',
      }),
    ],
  })
}

function RatePill({ video, run }) {
  const likeStatus = video?.likeStatus ?? -1
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
          children: jsx(IconBtn, { icon: I.thumbUp, onClick: () => run('toggleLike'), active: likeStatus === 2, size: 14, pad: 2, label: 'Like' }),
        }),
        jsx('div', { style: { width: '1px', alignSelf: 'stretch', backgroundColor: 'var(--ui-stroke-secondary)' } }),
        jsx('div', {
          style: { padding: '4px 12px', display: 'flex' },
          children: jsx(IconBtn, { icon: I.thumbDown, onClick: () => run('toggleDislike'), active: likeStatus === 0, size: 14, pad: 2, label: 'Dislike' }),
        }),
      ],
    }),
  })
}

function VolumeBar({ volume, run }) {
  const [dragging, setDragging] = useState(false)
  const [local, setLocal] = useState(volume ?? 50)
  useEffect(() => {
    if (!dragging) setLocal(volume ?? 50)
  }, [volume, dragging])

  const commit = (v) => {
    run('setVolume', v)
    setDragging(false)
  }

  return jsxs('div', {
    className: 'flex items-center gap-2 px-3 py-1 text-xs',
    children: [
      IconBtn({ icon: I.volume, onClick: () => run('mute'), size: 14, pad: 2, label: 'Mute' }),
      jsx('input', {
        type: 'range',
        min: 0,
        max: 100,
        value: dragging ? local : volume ?? 50,
        'aria-label': 'Volume',
        onPointerDown: () => setDragging(true),
        onPointerUp: () => commit(local),
        onKeyDown: (e) => {
          if (e.key === 'Enter') commit(local)
        },
        onChange: (e) => {
          setDragging(true)
          setLocal(Number(e.target.value))
        },
        style: { flex: 1, accentColor: 'var(--ui-accent)', height: '3px', cursor: 'pointer' },
      }),
      jsx('span', {
        className: 'text-(--ui-text-quaternary)',
        style: { width: '20px', textAlign: 'right' },
        children: String(dragging ? local : volume ?? 0),
      }),
    ],
  })
}

function QueueList({ state, run }) {
  const items = state?.player?.queue?.items || []
  const selected = state?.player?.queue?.selectedItemIndex ?? -1
  const [open, setOpen] = useState(false)
  if (!items.length) return null

  const rows = open
    ? items.slice(0, 12).map((item, i) =>
        jsx(
          'button',
          {
            type: 'button',
            onClick: () => run('playQueueIndex', i),
            title: item.title,
            style: {
              textAlign: 'left',
              background: i === selected ? 'var(--ui-surface-secondary, rgba(127,127,127,0.08))' : 'none',
              border: 'none',
              borderRadius: '4px',
              padding: '3px 6px',
              cursor: 'pointer',
              color: 'var(--ui-text-secondary)',
              fontSize: '11px',
            },
          },
          jsxs('div', {
            className: 'flex items-center gap-2 min-w-0',
            children: [
              jsx('span', {
                className: 'text-(--ui-text-quaternary)',
                style: { width: '14px', flexShrink: 0, textAlign: 'right' },
                children: String(i + 1),
              }),
              jsx('span', { className: 'truncate', children: item.title || 'Unknown' }),
            ],
          })
        )
      )
    : []

  return jsxs('div', {
    className: 'flex flex-col px-3 py-1 gap-1',
    children: [
      jsx('button', {
        type: 'button',
        onClick: () => setOpen((v) => !v),
        style: {
          textAlign: 'left',
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--ui-text-secondary)',
          fontSize: '11px',
          fontWeight: 600,
        },
        children: `${open ? 'Hide' : 'Show'} queue (${items.length})`,
      }),
      ...rows,
    ],
  })
}

function PlaylistBrowser({ run }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading, error } = useQuery({
    queryKey: ['ytm', 'playlists'],
    queryFn: getPlaylists,
    enabled: open,
    staleTime: 60_000,
    retry: 1,
  })
  const items = Array.isArray(data) ? data : []
  const rows = open
    ? items.map((p, i) =>
        jsx(
          'button',
          {
            type: 'button',
            onClick: () => {
              run('changeVideo', { videoId: null, playlistId: p.id })
              setOpen(false)
            },
            style: {
              textAlign: 'left',
              background: 'none',
              border: 'none',
              borderRadius: '4px',
              padding: '3px 6px',
              cursor: 'pointer',
              color: 'var(--ui-text-secondary)',
              fontSize: '11px',
            },
          },
          p.title || p.id
        )
      )
    : []

  return jsxs('div', {
    className: 'px-3 py-1',
    children: [
      jsx('button', {
        type: 'button',
        onClick: () => setOpen((v) => !v),
        style: {
          padding: '4px 8px',
          fontSize: '11px',
          borderRadius: '6px',
          border: '1px solid var(--ui-stroke-secondary)',
          background: 'none',
          cursor: 'pointer',
          color: 'var(--ui-text-secondary)',
        },
        children: open ? 'Hide playlists' : 'Playlists',
      }),
      open
        ? jsxs('div', {
            className: 'mt-1 flex flex-col gap-1 max-h-40 overflow-auto',
            children: [
              isLoading
                ? jsx('div', { className: 'text-xs text-(--ui-text-quaternary)', children: 'Loading… (can take up to 30s)' })
                : null,
              error
                ? jsx('div', { className: 'text-xs', style: { color: '#f59e0b' }, children: errText(error) })
                : null,
              ...rows,
            ],
          })
        : null,
    ],
  })
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

function YtmPane() {
  const queryClient = useQueryClient()
  useYtmEvents()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [settingsError, setSettingsError] = useState(null)
  const [auth, setAuth] = useState({ connecting: false, code: null, error: null })

  const { data: config, error: configError, isLoading: configLoading } = useYtmConfig()
  const baseUrl = config?.baseUrl
  const authorised = !!config?.hasToken

  const { data: state, error: stateError, isFetching } = useYtmState(baseUrl, authorised, 20_000)
  const { data: health } = useQuery({
    queryKey: ['ytm', 'health'],
    queryFn: getHealth,
    enabled: authorised,
    staleTime: 15_000,
    retry: 1,
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['ytm', 'config'] })
    queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] })
  }

  // One place that turns a command into a backend call plus a cache refresh.
  const run = (command, data) => {
    sendCommand(command, data)
      .catch(() => {})
      .then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }

  const connect = async () => {
    setAuth({ connecting: true, code: null, error: null })
    try {
      const res = await requestCode()
      setAuth({ connecting: true, code: res?.code || null, error: null })
      await requestToken(res?.code)
      setAuth({ connecting: false, code: null, error: null })
      refresh()
    } catch (e) {
      setAuth({ connecting: false, code: null, error: e })
    }
  }

  const disconnect = async () => {
    try {
      await forgetAuth()
    } catch (e) {}
    refresh()
  }

  const saveSettings = async (url, appId) => {
    setSaving(true)
    setSettingsError(null)
    try {
      // The backend owns address validation (and the LAN guard), so surface its
      // message verbatim rather than duplicating the rules here.
      await saveConfig({ baseUrl: url, appId })
      await probeServer()
      refresh()
      setSettingsOpen(false)
    } catch (e) {
      setSettingsError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const header = jsx(Header, {
    connected: authorised,
    artist: state?.video?.author,
    onDisconnect: disconnect,
    onSettings: () => setSettingsOpen((v) => !v),
  })

  let body
  if (configError) {
    // The backend half is not loaded: either the plugin is missing from
    // plugins.enabled in config.yaml, or importing plugin_api.py failed.
    body = jsx(Notice, {
      title: 'Plugin backend unavailable.',
      detail: 'Enable ytm-control in plugins.enabled (config.yaml), then restart Hermes.',
      mono: errText(configError),
    })
  } else if (configLoading && !config) {
    body = jsx(Notice, { title: 'Starting…' })
  } else if (!authorised) {
    body = jsx('div', {
      children: jsx(AuthScreen, {
        onConnect: connect,
        connecting: auth.connecting,
        code: auth.code,
        error: auth.error,
      }),
    })
  } else if (stateError && !state) {
    body = jsx(Notice, {
      title: 'Cannot reach the Companion Server.',
      detail: `Check YT Music Desktop is running and the Companion Server is enabled at ${baseUrl}.`,
      mono: errText(stateError),
    })
  } else {
    const player = state?.player
    body = jsxs('div', {
      className: 'flex flex-col',
      children: [
        health && health.realtime === false
          ? jsx('div', {
              className: 'text-xs px-3 pb-1',
              style: { color: '#f59e0b' },
              children: 'Realtime unavailable (python-socketio not installed) — falling back to polling.',
            })
          : null,
        jsx(NowPlaying, { video: state?.video, loading: isFetching && !state }),
        jsx(SeekBar, { progress: player?.videoProgress ?? 0, duration: state?.video?.durationSeconds ?? 0, run }),
        jsx(Transport, { player, run }),
        jsx(ExtraControls, { state, run }),
        jsx(VolumeBar, { volume: player?.volume, run }),
        jsx(QueueList, { state, run }),
        jsx(PlaylistBrowser, { run }),
        jsx(RatePill, { video: state?.video, run }),
      ],
    })
  }

  return jsxs('div', {
    className: 'flex h-full flex-col text-sm',
    children: [
      header,
      jsx(Separator, {}),
      settingsOpen
        ? jsx(SettingsForm, {
            initial: { url: baseUrl || DEFAULT_BASE, appId: config?.appId || 'hermesdesktop01' },
            onSave: saveSettings,
            onCancel: () => setSettingsOpen(false),
            saving,
            error: settingsError,
          })
        : null,
      settingsOpen ? jsx(Separator, {}) : null,
      body,
    ],
  })
}

// ---------------------------------------------------------------------------
// Statusbar chip
// ---------------------------------------------------------------------------

function StatusChip() {
  const queryClient = useQueryClient()
  useYtmEvents()
  const { data: config } = useYtmConfig()
  const authorised = !!config?.hasToken
  const { data: state } = useYtmState(config?.baseUrl, authorised, 30_000)

  if (!authorised) return null
  const player = state?.player
  const video = state?.video
  const title = video?.title
  if (!title) return null
  const isPlaying = (player?.trackState ?? -1) === 1

  const toggle = () => {
    haptic('tap')
    sendCommand('playPause')
      .catch(() => {})
      .then(() => queryClient.invalidateQueries({ queryKey: ['ytm', 'state'] }))
  }

  return jsxs('button', {
    type: 'button',
    onClick: toggle,
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
        style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '90px' },
        children: title,
      }),
      video?.author
        ? jsx('span', {
            style: {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '70px',
              color: 'var(--ui-text-quaternary)',
            },
            children: ` — ${video.author}`,
          })
        : null,
      jsx('span', {
        style: { flexShrink: 0, color: 'var(--ui-text-quaternary)' },
        children: ` · ${fmtTime(player?.videoProgress ?? 0)}/${fmtTime(video?.durationSeconds ?? 0)}`,
      }),
    ],
  })
}

export default {
  id: 'ytm-control',
  name: 'YouTube Music Control',
  version: APP_VERSION,
  register(ctx) {
    pluginCtx = ctx
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
