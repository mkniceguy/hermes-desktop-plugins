/**
 * plex-status — Hermes Desktop Plugin
 *
 * Plex activity pane backed by Tautulli: active streams, bandwidth,
 * transcode indicator, recently added.
 *
 * Config: URL + API key are stored in plugin-local storage (ctx.storage)
 * via the in-pane settings form. Nothing secret lives in this file.
 */
import { Separator, useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const POLL_MS = 15_000
const RECENT_COUNT = 5

let storage = null

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------
function getCfg() {
  return {
    url: (storage?.get('url') || '').replace(/\/+$/, ''),
    key: storage?.get('key') || '',
  }
}

// ---------------------------------------------------------------------------
// Tautulli API
// ---------------------------------------------------------------------------
async function tautulli(url, key, cmd, extra = '') {
  const res = await fetch(`${url}/api/v2?apikey=${key}&cmd=${cmd}${extra}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const inner = json?.response
  if (inner?.result !== 'success' || inner?.data === undefined) {
    throw new Error(inner?.message || 'Tautulli API error')
  }
  return inner.data
}

async function fetchActivity(url, key) {
  const d = await tautulli(url, key, 'get_activity')
  return {
    streamCount: parseInt(d.stream_count, 10) || 0,
    bandwidthMbps: ((Number(d.total_bandwidth) || 0) / 1000).toFixed(1),
    sessions: (d.sessions ?? []).map((s) => {
      const mt = (s.media_type ?? '').toLowerCase()
      const transcode = (s.transcode_decision ?? '').toLowerCase()
      // Detail of which legs are transcoding (video/audio/subtitle)
      const legs = []
      if ((s.stream_video_decision ?? s.video_decision ?? '').toLowerCase() === 'transcode') legs.push('video')
      if ((s.stream_audio_decision ?? s.audio_decision ?? '').toLowerCase() === 'transcode') legs.push('audio')
      if ((s.stream_subtitle_decision ?? s.subtitle_decision ?? '').toLowerCase() === 'transcode') legs.push('subtitle')
      return {
        key: `${s.session_key ?? s.id ?? ''}|${s.user ?? ''}|${s.title ?? ''}|${transcode}`,
        title: s.grandparent_title && mt === 'episode'
          ? `${s.grandparent_title} — ${s.title}`
          : (s.title ?? s.full_title ?? 'Unknown'),
        user: s.user ?? s.username ?? 'unknown',
        state: s.state ?? '',
        progress: s.progress_percent ?? '',
        quality: s.quality_profile ?? '',
        transcoding: transcode === 'transcode',
        transcodeLegs: legs,
        verb: mt === 'track' || mt === 'music' ? 'listening to' : 'watching',
      }
    }),
  }
}

async function fetchRecent(url, key) {
  const d = await tautulli(url, key, 'get_recently_added', `&count=${RECENT_COUNT}`)
  return (d.recently_added ?? []).map((r) => ({
    title: r.grandparent_title && r.media_type === 'episode'
      ? `${r.grandparent_title} — ${r.title}`
      : (r.title ?? 'Unknown'),
    type: r.media_type ?? '',
    addedAt: r.added_at ? new Date(Number(r.added_at) * 1000).toLocaleDateString() : '',
  }))
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------
function StatusDot({ active, warn }) {
  return jsx('span', {
    style: {
      display: 'inline-block',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: warn ? '#f59e0b' : active ? '#22c55e' : 'var(--ui-text-quaternary)',
      flexShrink: 0,
    },
  })
}

function Header({ streamCount, bandwidthMbps, active, warn, onSettings }) {
  return jsxs('div', {
    className: 'flex items-center gap-2 px-3 py-2 text-sm font-medium',
    style: active ? { backgroundColor: warn ? 'rgba(245, 158, 11, 0.06)' : 'rgba(34, 197, 94, 0.06)' } : undefined,
    children: [
      jsx(StatusDot, { active, warn }),
      jsx('span', { children: 'Plex' }),
      active
        ? jsx('span', {
            className: 'ml-1 text-xs text-(--ui-text-tertiary) flex-1',
            children: `${streamCount} stream${streamCount !== 1 ? 's' : ''} · ${bandwidthMbps} Mbps`,
          })
        : jsx('span', { className: 'flex-1' }),
      jsx('button', {
        type: 'button',
        onClick: onSettings,
        title: 'Settings',
        style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: '10px', color: 'var(--ui-text-quaternary)', padding: '2px 4px' },
        children: '⚙',
      }),
    ],
  })
}

function TranscodeBadge({ legs }) {
  return jsx('span', {
    title: legs?.length ? `Transcoding: ${legs.join(', ')}` : 'Transcoding',
    style: {
      display: 'inline-block',
      fontSize: '9px',
      fontWeight: 600,
      letterSpacing: '0.03em',
      padding: '1px 5px',
      borderRadius: '4px',
      marginLeft: '6px',
      verticalAlign: '1px',
      color: '#f59e0b',
      border: '1px solid rgba(245, 158, 11, 0.4)',
      backgroundColor: 'rgba(245, 158, 11, 0.08)',
    },
    children: legs?.length ? `TRANSCODE · ${legs.join('/')}` : 'TRANSCODE',
  })
}

function SessionRow({ session }) {
  const detail = [session.state, session.progress ? `${session.progress}%` : '', session.quality]
    .filter(Boolean)
    .join(' · ')
  return jsxs('div', {
    className: 'flex flex-col gap-0.5 px-3 py-1.5 text-xs',
    children: [
      jsxs('div', {
        children: [
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: `${session.user} ${session.verb} ` }),
          jsx('span', { className: 'font-medium', children: session.title }),
          session.transcoding ? jsx(TranscodeBadge, { legs: session.transcodeLegs }) : null,
        ],
      }),
      detail ? jsx('div', { className: 'text-(--ui-text-secondary)', children: detail }) : null,
    ],
  })
}

function RecentStrip({ items }) {
  if (!items?.length) return null
  return jsxs('div', {
    className: 'flex flex-col',
    children: [
      jsx(Separator, {}),
      jsx('div', {
        className: 'px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-(--ui-text-quaternary)',
        children: 'Recently added',
      }),
      jsx('div', {
        className: 'pb-2',
        children: items.map((r, i) =>
          jsxs('div', {
            className: 'px-3 py-0.5 text-xs flex items-baseline gap-2',
            children: [
              jsx('span', { className: 'truncate flex-1', children: r.title }),
              jsx('span', {
                className: 'text-(--ui-text-quaternary)',
                style: { fontSize: '10px', flexShrink: 0 },
                children: r.addedAt,
              }),
            ],
          }, i)
        ),
      }),
    ],
  })
}

function SettingsForm({ initial, onSave, onCancel, saving, error }) {
  const [url, setUrl] = useState(initial.url)
  const [key, setKey] = useState(initial.key)
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
  return jsxs('div', {
    className: 'flex flex-col gap-2 px-3 py-3 text-xs',
    children: [
      jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Tautulli connection' }),
      jsx('input', {
        type: 'text',
        placeholder: 'URL — http://192.168.0.3:30047',
        value: url,
        onChange: (e) => setUrl(e.target.value),
        style: inputStyle,
      }),
      jsx('input', {
        type: 'password',
        placeholder: 'API key',
        value: key,
        onChange: (e) => setKey(e.target.value),
        style: inputStyle,
      }),
      error ? jsx('div', { style: { color: '#f59e0b' }, children: error }) : null,
      jsxs('div', {
        className: 'flex gap-2',
        children: [
          jsx('button', {
            type: 'button',
            disabled: saving || !url || !key,
            onClick: () => onSave(url.trim(), key.trim()),
            style: {
              padding: '5px 12px',
              fontSize: '12px',
              borderRadius: '6px',
              border: '1px solid var(--ui-stroke-secondary)',
              background: 'none',
              cursor: saving ? 'wait' : 'pointer',
              color: 'var(--ui-text-secondary)',
              opacity: saving || !url || !key ? 0.5 : 1,
            },
            children: saving ? 'Testing…' : 'Save & test',
          }),
          initial.url
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

// ---------------------------------------------------------------------------
// Main pane
// ---------------------------------------------------------------------------
function PlexPane() {
  const queryClient = useQueryClient()
  const [cfg, setCfg] = useState(getCfg)
  const [editing, setEditing] = useState(!cfg.url || !cfg.key)
  const [testState, setTestState] = useState({ saving: false, error: null })

  const configured = Boolean(cfg.url && cfg.key) && !editing

  const { data, error, isLoading } = useQuery({
    queryKey: ['plex', 'activity', cfg.url, cfg.key],
    queryFn: () => fetchActivity(cfg.url, cfg.key),
    enabled: configured,
    refetchInterval: POLL_MS,
    retry: false,
    staleTime: Math.floor(POLL_MS / 2),
  })

  const { data: recent } = useQuery({
    queryKey: ['plex', 'recent', cfg.url, cfg.key],
    queryFn: () => fetchRecent(cfg.url, cfg.key),
    enabled: configured,
    refetchInterval: POLL_MS * 4,
    retry: false,
    staleTime: POLL_MS * 2,
  })

  const handleSave = async (url, key) => {
    setTestState({ saving: true, error: null })
    try {
      await fetchActivity(url, key) // test before persisting
      storage?.set('url', url)
      storage?.set('key', key)
      setCfg({ url, key })
      setEditing(false)
      setTestState({ saving: false, error: null })
      queryClient.invalidateQueries({ queryKey: ['plex'] })
    } catch (e) {
      setTestState({ saving: false, error: `Test failed: ${e.message}` })
    }
  }

  // Settings / unconfigured
  if (editing) {
    return jsxs('div', {
      className: 'flex h-full flex-col text-sm',
      children: [
        jsx(Header, { streamCount: 0, bandwidthMbps: '0', active: false, onSettings: () => {} }),
        jsx(Separator, {}),
        jsx(SettingsForm, {
          initial: cfg,
          onSave: handleSave,
          onCancel: () => setEditing(false),
          saving: testState.saving,
          error: testState.error,
        }),
      ],
    })
  }

  // Error
  if (error && !data) {
    return jsxs('div', {
      className: 'flex h-full flex-col text-sm',
      children: [
        jsx(Header, { streamCount: 0, bandwidthMbps: '0', active: false, onSettings: () => setEditing(true) }),
        jsx(Separator, {}),
        jsx('div', {
          className: 'px-3 py-4 text-xs text-(--ui-text-tertiary)',
          children: `Tautulli unreachable: ${error.message}`,
        }),
      ],
    })
  }

  // Loading
  if (isLoading && !data) {
    return jsxs('div', {
      className: 'flex h-full flex-col text-sm',
      children: [
        jsx(Header, { streamCount: 0, bandwidthMbps: '0', active: false, onSettings: () => setEditing(true) }),
        jsx(Separator, {}),
        jsx('div', { className: 'px-3 py-4 text-xs text-(--ui-text-tertiary)', children: 'Connecting to Tautulli…' }),
      ],
    })
  }

  const { streamCount, bandwidthMbps, sessions } = data
  const active = streamCount > 0
  const anyTranscode = sessions.some((s) => s.transcoding)

  return jsxs('div', {
    className: 'flex h-full flex-col text-sm',
    children: [
      jsx(Header, { streamCount, bandwidthMbps, active, warn: anyTranscode, onSettings: () => setEditing(true) }),
      jsx(Separator, {}),
      !active
        ? jsx('div', { className: 'px-3 py-4 text-xs text-(--ui-text-tertiary)', children: 'No active streams' })
        : jsx('div', {
            className: 'py-1',
            children: sessions.map((s) => jsx(SessionRow, { session: s }, s.key)),
          }),
      jsx(RecentStrip, { items: recent }),
    ],
  })
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export default {
  id: 'plex-status',
  name: 'Plex Status',
  register(ctx) {
    storage = ctx.storage
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'plex status',
      data: { placement: 'right', width: '280px' },
      render: () => jsx(PlexPane, {}),
    })
  },
}
