/**
 * plex-status — Hermes Desktop Plugin (v0.3.0)
 *
 * Plex activity pane and statusbar mini-chip backed by Tautulli: active
 * streams with per-session progress bars, client/device info, LAN/WAN
 * bandwidth breakdown, hardware/software transcode badges (video/audio/subtitle
 * legs), recently added media strip with SxxExx & media-type tags, and Ctrl+K
 * Command Palette actions.
 *
 * ARCHITECTURE (v0.3.0)
 * ---------------------
 * This half is presentation only. Every byte of state goes through the
 * plugin's own backend namespace — /api/plugins/plex-status/ — via `ctx.rest`,
 * and live updates arrive via `host.onEvent`. The renderer NEVER contacts
 * Tautulli directly and never holds the API key in browser storage or DevTools
 * network URLs.
 *
 * One-time migration: if legacy `url` + `key` exist in `ctx.storage` from
 * v0.1/v0.2 and the backend is unconfigured, the plugin automatically migrates
 * them into the backend (`POST /configure`) and wipes `ctx.storage`.
 */
import {
  Separator,
  ScrollArea,
  useQuery,
  useQueryClient,
  queryClient as globalQueryClient,
  host,
  haptic,
  PALETTE_AREA,
} from '@hermes/plugin-sdk'
import { useState, useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const APP_VERSION = '0.3.0'
const POLL_MS = 15_000
const RECENT_COUNT = 8

const CONFIG_KEY = ['plex', 'config']
const COLOR_ACTIVE = 'var(--ui-success, var(--ui-accent))'
const COLOR_WARN = 'var(--ui-warning, var(--ui-accent))'
const COLOR_INACTIVE = 'var(--ui-text-quaternary)'

let pluginCtx = null

// ---------------------------------------------------------------------------
// Backend calls — single data path, scoped to /api/plugins/plex-status
// ---------------------------------------------------------------------------
function rest(path, opts) {
  if (!pluginCtx) throw new Error('The plex-status backend is not loaded.')
  return pluginCtx.rest(path, opts)
}

const getConfig = () => rest('/config')
const saveConfig = (body) => rest('/configure', { method: 'POST', body })
const forgetAuth = () => rest('/auth', { method: 'DELETE' })
const getActivity = (force = false) => rest(force ? '/activity?force=true' : '/activity')
const getRecent = (count = RECENT_COUNT, force = false) =>
  rest(`/recent?count=${count}${force ? '&force=true' : ''}`)

function errText(e) {
  const raw = e?.message || String(e)
  return raw.replace(/^Error:\s*/, '')
}

function fmtRelativeDate(epochSec) {
  if (!epochSec) return ''
  const d = new Date(Number(epochSec) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diffSec >= 0 && diffSec < 3600) return `${Math.max(1, Math.floor(diffSec / 60))}m ago`
  if (diffSec >= 3600 && diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec >= 86400 && diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)}d ago`
  return d.toLocaleDateString()
}

// ---------------------------------------------------------------------------
// Reactive hooks & event subscription
// ---------------------------------------------------------------------------
function usePlexEvents() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const invalidateActivity = () => queryClient.invalidateQueries({ queryKey: ['plex', 'activity'] })
    const invalidateAll = () => queryClient.invalidateQueries({ queryKey: ['plex'] })
    const disposers = [
      host.onEvent('plugin.plex-status.activity.updated', invalidateActivity),
      host.onEvent('plugin.plex-status.config.changed', invalidateAll),
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

function usePlexConfig() {
  return useQuery({
    queryKey: CONFIG_KEY,
    queryFn: getConfig,
    staleTime: 10_000,
    retry: 1,
  })
}

function usePlexActivity(baseUrl, enabled, refetchInterval = POLL_MS) {
  return useQuery({
    queryKey: ['plex', 'activity', baseUrl || 'default'],
    queryFn: () => getActivity(false),
    enabled,
    refetchInterval,
    retry: 1,
    staleTime: 5_000,
  })
}

function usePlexRecent(baseUrl, enabled) {
  return useQuery({
    queryKey: ['plex', 'recent', baseUrl || 'default'],
    queryFn: () => getRecent(RECENT_COUNT, false),
    enabled,
    refetchInterval: POLL_MS * 4,
    retry: 1,
    staleTime: 30_000,
  })
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------
function IndicatorDot({ active, warn }) {
  return jsx('span', {
    style: {
      display: 'inline-block',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: warn ? COLOR_WARN : active ? COLOR_ACTIVE : COLOR_INACTIVE,
      flexShrink: 0,
    },
  })
}

function Header({ activity, configured, staleError, isFetching, onRefresh, onSettings }) {
  const streamCount = activity?.streamCount ?? 0
  const bandwidthMbps = activity?.bandwidthMbps ?? '0.0'
  const lanBw = Number(activity?.lanBandwidthMbps || 0)
  const wanBw = Number(activity?.wanBandwidthMbps || 0)
  const active = configured && streamCount > 0
  const anyTranscode = (activity?.sessions ?? []).some((s) => s.transcoding)
  const warn = Boolean(staleError) || anyTranscode

  const bwTitle = active
    ? `Total: ${bandwidthMbps} Mbps (LAN: ${lanBw.toFixed(1)} Mbps · WAN: ${wanBw.toFixed(1)} Mbps)`
    : undefined

  return jsxs('div', {
    className: 'flex items-center gap-1.5 px-3 py-2 text-sm font-medium',
    style: active
      ? { backgroundColor: 'color-mix(in srgb, var(--ui-accent) 8%, transparent)' }
      : undefined,
    children: [
      jsx(IndicatorDot, { active, warn }),
      jsx('span', { children: 'Plex' }),
      active
        ? jsx('span', {
            className: 'ml-1 text-xs text-(--ui-text-tertiary) flex-1 truncate',
            title: bwTitle,
            children: `${streamCount} stream${streamCount !== 1 ? 's' : ''} · ${bandwidthMbps} Mbps${
              wanBw > 0 ? ` (${wanBw.toFixed(1)} WAN)` : ''
            }`,
          })
        : jsx('span', { className: 'flex-1' }),
      configured
        ? jsx('button', {
            type: 'button',
            onClick: onRefresh,
            title: isFetching ? 'Refreshing…' : 'Refresh activity',
            style: {
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '11px',
              color: 'var(--ui-text-quaternary)',
              padding: '2px 4px',
              opacity: isFetching ? 0.5 : 1,
            },
            children: '↻',
          })
        : null,
      jsx('button', {
        type: 'button',
        onClick: onSettings,
        title: 'Settings',
        style: {
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: '11px',
          color: 'var(--ui-text-quaternary)',
          padding: '2px 4px',
        },
        children: '⚙',
      }),
    ],
  })
}

function Notice({ title, detail, mono }) {
  return jsxs('div', {
    className: 'flex flex-col gap-1.5 px-3 py-4 text-xs',
    children: [
      jsx('div', { className: 'font-medium text-(--ui-text-secondary)', children: title }),
      detail ? jsx('div', { className: 'text-(--ui-text-tertiary)', children: detail }) : null,
      mono
        ? jsx('div', {
            className: 'text-(--ui-text-quaternary)',
            style: { fontFamily: 'var(--font-mono, monospace)', fontSize: '11px', wordBreak: 'break-word' },
            children: mono,
          })
        : null,
    ],
  })
}

function TranscodeBadge({ legs, hw }) {
  const legText = legs?.length ? legs.join('/') : ''
  const hwText = hw ? 'HW' : ''
  const suffix = [hwText, legText].filter(Boolean).join(' · ')
  return jsx('span', {
    title: legs?.length
      ? `Transcoding (${hw ? 'hardware' : 'software'}): ${legs.join(', ')}`
      : 'Transcoding',
    style: {
      display: 'inline-block',
      fontSize: '9px',
      fontWeight: 600,
      letterSpacing: '0.03em',
      padding: '1px 5px',
      borderRadius: '4px',
      marginLeft: '6px',
      verticalAlign: '1px',
      color: COLOR_WARN,
      border: '1px solid var(--ui-stroke-secondary)',
    },
    children: suffix ? `TRANSCODE · ${suffix}` : 'TRANSCODE',
  })
}

function SessionRow({ session }) {
  const metaParts = [
    session.state,
    session.progress !== undefined ? `${session.progress}%` : '',
    session.quality,
    session.player,
    session.location ? session.location.toUpperCase() : '',
    session.bandwidthMbps ? `${session.bandwidthMbps} Mbps` : '',
  ].filter(Boolean)

  const pct = Math.max(0, Math.min(100, Number(session.progress) || 0))

  return jsxs('div', {
    className: 'flex flex-col gap-1 px-3 py-2 text-xs',
    style: { borderBottom: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 40%, transparent)' },
    children: [
      jsxs('div', {
        className: 'leading-snug',
        children: [
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: `${session.user} ${session.verb} ` }),
          jsx('span', { className: 'font-medium text-(--ui-text-primary)', children: session.title }),
          session.transcoding
            ? jsx(TranscodeBadge, { legs: session.transcodeLegs, hw: session.transcodeHw })
            : null,
        ],
      }),
      metaParts.length
        ? jsx('div', {
            className: 'text-(--ui-text-secondary) truncate',
            style: { fontSize: '11px' },
            children: metaParts.join(' · '),
          })
        : null,
      jsx('div', {
        style: {
          width: '100%',
          height: '3px',
          borderRadius: '2px',
          backgroundColor: 'color-mix(in srgb, var(--ui-stroke-secondary) 60%, transparent)',
          overflow: 'hidden',
          marginTop: '2px',
        },
        children: jsx('div', {
          style: {
            width: `${pct}%`,
            height: '100%',
            backgroundColor: session.transcoding ? COLOR_WARN : COLOR_ACTIVE,
            transition: 'width 0.3s ease',
          },
        }),
      }),
    ],
  })
}

function MediaTypeBadge({ type }) {
  const label =
    type === 'episode' ? 'TV' : type === 'movie' ? 'MOVIE' : type === 'album' || type === 'track' ? 'MUSIC' : type.toUpperCase()
  return jsx('span', {
    style: {
      fontSize: '9px',
      fontWeight: 600,
      letterSpacing: '0.03em',
      padding: '0 4px',
      borderRadius: '3px',
      color: 'var(--ui-text-tertiary)',
      border: '1px solid var(--ui-stroke-secondary)',
      flexShrink: 0,
    },
    children: label,
  })
}

function RecentStrip({ items }) {
  const [collapsed, setCollapsed] = useState(false)
  if (!items?.length) return null

  const rows = !collapsed
    ? items.map((r, i) =>
        jsxs(
          'div',
          {
            className: 'px-3 py-1 text-xs flex items-center gap-1.5',
            children: [
              jsx(MediaTypeBadge, { type: r.mediaType || 'media' }),
              jsx('span', {
                className: 'truncate flex-1',
                title: r.year ? `${r.title} (${r.year})` : r.title,
                children: r.title,
              }),
              jsx('span', {
                className: 'text-(--ui-text-quaternary)',
                style: { fontSize: '10px', flexShrink: 0 },
                children: fmtRelativeDate(r.addedAt),
              }),
            ],
          },
          `${r.title}-${i}`
        )
      )
    : []

  return jsxs('div', {
    className: 'flex flex-col',
    children: [
      jsx(Separator, {}),
      jsxs('button', {
        type: 'button',
        onClick: () => setCollapsed((v) => !v),
        className: 'px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-(--ui-text-quaternary) flex items-center justify-between',
        style: { background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' },
        children: [
          jsx('span', { children: `Recently added (${items.length})` }),
          jsx('span', { children: collapsed ? '▸' : '▾' }),
        ],
      }),
      !collapsed ? jsx('div', { className: 'pb-2', children: rows }) : null,
    ],
  })
}

function SettingsForm({ initialUrl, hasKey, onSave, onCancel, onForget, saving, error }) {
  const [url, setUrl] = useState(initialUrl || '')
  const [key, setKey] = useState('')
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
  const btnStyle = {
    padding: '5px 12px',
    fontSize: '12px',
    borderRadius: '6px',
    border: '1px solid var(--ui-stroke-secondary)',
    background: 'none',
    cursor: saving ? 'wait' : 'pointer',
    color: 'var(--ui-text-secondary)',
  }
  const canSubmit = !saving && Boolean(url.trim()) && (Boolean(key.trim()) || hasKey)

  return jsxs('div', {
    className: 'flex flex-col gap-2 px-3 py-3 text-xs',
    children: [
      jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Tautulli connection (stored in backend)' }),
      jsx('input', {
        type: 'text',
        placeholder: 'URL — e.g. http://192.168.0.3:30047',
        value: url,
        onChange: (e) => setUrl(e.target.value),
        style: inputStyle,
      }),
      jsx('input', {
        type: 'password',
        placeholder: hasKey ? 'API key (saved — leave blank to keep)' : 'Tautulli API key',
        value: key,
        onChange: (e) => setKey(e.target.value),
        style: inputStyle,
      }),
      error ? jsx('div', { style: { color: COLOR_WARN }, children: error }) : null,
      jsxs('div', {
        className: 'flex gap-2 items-center',
        children: [
          jsx('button', {
            type: 'button',
            disabled: !canSubmit,
            onClick: () => onSave(url.trim(), key.trim()),
            style: { ...btnStyle, opacity: canSubmit ? 1 : 0.5 },
            children: saving ? 'Testing…' : 'Save & test',
          }),
          hasKey
            ? jsx('button', {
                type: 'button',
                onClick: onCancel,
                style: { ...btnStyle, border: 'none', color: 'var(--ui-text-quaternary)' },
                children: 'Cancel',
              })
            : null,
          hasKey
            ? jsx('button', {
                type: 'button',
                onClick: onForget,
                style: { ...btnStyle, border: 'none', marginLeft: 'auto', color: 'var(--ui-text-quaternary)' },
                children: 'Forget',
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
  usePlexEvents()

  const { data: config, error: configError, isLoading: configLoading } = usePlexConfig()
  const configured = Boolean(config?.baseUrl && config?.hasKey)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [settingsError, setSettingsError] = useState(null)

  // One-time seamless migration from v0.1/v0.2 renderer storage to v0.3 backend
  useEffect(() => {
    if (!config || configured || !pluginCtx?.storage) return
    const legacyUrl = pluginCtx.storage.get('url')
    const legacyKey = pluginCtx.storage.get('key')
    if (legacyUrl && legacyKey) {
      saveConfig({ baseUrl: legacyUrl, apiKey: legacyKey })
        .then(() => {
          pluginCtx.storage.remove('url')
          pluginCtx.storage.remove('key')
          queryClient.invalidateQueries({ queryKey: ['plex'] })
        })
        .catch(() => {})
    }
  }, [config, configured, queryClient])

  const {
    data: activity,
    error: activityError,
    isLoading: activityLoading,
    isFetching: activityFetching,
  } = usePlexActivity(config?.baseUrl, configured, POLL_MS)

  const { data: recentData } = usePlexRecent(config?.baseUrl, configured)

  const handleRefresh = () => {
    haptic('tap')
    getActivity(true)
      .then(() => queryClient.invalidateQueries({ queryKey: ['plex', 'activity'] }))
      .catch(() => queryClient.invalidateQueries({ queryKey: ['plex', 'activity'] }))
  }

  const handleSave = async (rawUrl, rawKey) => {
    setSaving(true)
    setSettingsError(null)
    try {
      await saveConfig({ baseUrl: rawUrl, apiKey: rawKey || undefined })
      if (pluginCtx?.storage) {
        pluginCtx.storage.remove('url')
        pluginCtx.storage.remove('key')
      }
      setSettingsOpen(false)
      queryClient.invalidateQueries({ queryKey: ['plex'] })
    } catch (e) {
      setSettingsError(`Test failed: ${errText(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleForget = async () => {
    setSaving(true)
    setSettingsError(null)
    try {
      await forgetAuth()
      setSettingsOpen(false)
      queryClient.removeQueries({ queryKey: ['plex', 'activity'] })
      queryClient.removeQueries({ queryKey: ['plex', 'recent'] })
      queryClient.invalidateQueries({ queryKey: CONFIG_KEY })
    } catch (e) {
      setSettingsError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const showSettings = settingsOpen || (config && !configured)

  let body
  if (configError) {
    body = jsx(Notice, {
      title: 'Plugin backend unavailable.',
      detail: 'Enable plex-status in plugins.enabled (config.yaml), then restart Hermes.',
      mono: errText(configError),
    })
  } else if (configLoading && !config) {
    body = jsx(Notice, { title: 'Starting…' })
  } else if (!configured) {
    body = null // SettingsForm is rendered above
  } else if (activityError && !activity) {
    body = jsx(Notice, {
      title: 'Tautulli unreachable.',
      detail: `Check that Tautulli is running at ${config?.baseUrl}.`,
      mono: errText(activityError),
    })
  } else if (activityLoading && !activity) {
    body = jsx(Notice, { title: 'Connecting to Tautulli…' })
  } else {
    const sessions = activity?.sessions ?? []
    const active = (activity?.streamCount ?? 0) > 0
    const sessionRows = active ? sessions.map((s) => jsx(SessionRow, { session: s }, s.key)) : []

    body = jsx(ScrollArea, {
      className: 'flex-1',
      children: jsxs('div', {
        className: 'flex flex-col',
        children: [
          activityError
            ? jsx('div', {
                className: 'px-3 py-1 text-[11px]',
                style: { color: COLOR_WARN },
                children: `Offline (showing cached state): ${errText(activityError)}`,
              })
            : null,
          !active
            ? jsx('div', {
                className: 'px-3 py-4 text-xs text-(--ui-text-tertiary)',
                children: 'No active streams',
              })
            : jsx('div', { className: 'py-0.5', children: sessionRows }),
          jsx(RecentStrip, { items: recentData?.items }),
        ],
      }),
    })
  }

  return jsxs('div', {
    className: 'flex h-full flex-col text-sm',
    children: [
      jsx(Header, {
        activity,
        configured,
        staleError: activityError,
        isFetching: activityFetching,
        onRefresh: handleRefresh,
        onSettings: () => setSettingsOpen((v) => !v),
      }),
      jsx(Separator, {}),
      showSettings
        ? jsx(SettingsForm, {
            initialUrl: config?.baseUrl || '',
            hasKey: configured,
            onSave: handleSave,
            onCancel: () => setSettingsOpen(false),
            onForget: handleForget,
            saving,
            error: settingsError,
          })
        : null,
      showSettings && configured ? jsx(Separator, {}) : null,
      body,
    ],
  })
}

// ---------------------------------------------------------------------------
// Statusbar mini-chip
// ---------------------------------------------------------------------------
function PlexStatusChip() {
  const queryClient = useQueryClient()
  usePlexEvents()
  const { data: config } = usePlexConfig()
  const configured = Boolean(config?.baseUrl && config?.hasKey)
  const { data: activity } = usePlexActivity(config?.baseUrl, configured, 30_000)

  if (!configured) return null
  const streamCount = activity?.streamCount ?? 0
  if (streamCount <= 0) return null

  const anyTranscode = (activity?.sessions ?? []).some((s) => s.transcoding)
  const bw = activity?.bandwidthMbps ?? '0.0'
  const firstSession = activity?.sessions?.[0]
  const tooltip = firstSession
    ? `Plex: ${streamCount} stream${streamCount !== 1 ? 's' : ''} (${bw} Mbps) — ${firstSession.user}: ${firstSession.title}`
    : `Plex: ${streamCount} stream${streamCount !== 1 ? 's' : ''} (${bw} Mbps)`

  const handleClick = () => {
    haptic('tap')
    getActivity(true)
      .then(() => queryClient.invalidateQueries({ queryKey: ['plex', 'activity'] }))
      .catch(() => {})
  }

  return jsxs('button', {
    type: 'button',
    onClick: handleClick,
    title: tooltip,
    'aria-label': tooltip,
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
    },
    children: [
      jsx(IndicatorDot, { active: true, warn: anyTranscode }),
      jsx('span', { children: `Plex ${streamCount} · ${bw} Mbps` }),
    ],
  })
}

function paletteRefresh() {
  haptic('tap')
  getActivity(true)
    .then(() => globalQueryClient?.invalidateQueries({ queryKey: ['plex', 'activity'] }))
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------
export default {
  id: 'plex-status',
  name: 'Plex Status',
  version: APP_VERSION,
  register(ctx) {
    pluginCtx = ctx
    ctx.registerMany([
      {
        id: 'pane',
        area: 'panes',
        title: 'plex status',
        data: { placement: 'right', width: '290px' },
        render: () => jsx(PlexPane, {}),
      },
      {
        id: 'chip',
        area: 'statusBar.right',
        order: 132,
        render: () => jsx(PlexStatusChip, {}),
      },
      {
        id: 'cmd-refresh',
        area: PALETTE_AREA,
        data: {
          id: 'plex.refresh',
          label: 'Plex Status: Refresh Activity',
          keywords: ['plex', 'tautulli', 'streams', 'refresh'],
          run: paletteRefresh,
        },
      },
    ])
  },
}
