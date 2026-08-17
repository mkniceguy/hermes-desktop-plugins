/**
 * plex-status — Hermes Desktop Plugin
 *
 * Shows active Plex streaming status in a right-side pane, polling
 * Tautulli's get_activity endpoint via React Query.
 *
 * Setup: set TAUTULLI_URL and TAUTULLI_API_KEY below, then save.
 */
import { Separator, useQuery } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const TAUTULLI_URL = ''  // e.g. 'http://192.168.0.10:8181'
const TAUTULLI_API_KEY = ''  // Tautulli → Settings → Web Interface → API Key
const POLL_MS = 15_000

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
const isConfigured = Boolean(TAUTULLI_URL && TAUTULLI_API_KEY)

function activityUrl() {
  const base = TAUTULLI_URL.replace(/\/+$/, '')
  return `${base}/api/v2?apikey=${TAUTULLI_API_KEY}&cmd=get_activity`
}

async function fetchActivity() {
  const res = await fetch(activityUrl())
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const inner = json?.response
  if (inner?.result !== 'success' || !inner?.data) {
    throw new Error(inner?.message || 'Tautulli API error')
  }
  const d = inner.data
  return {
    streamCount: parseInt(d.stream_count, 10) || 0,
    bandwidthMbps: ((Number(d.total_bandwidth) || 0) / 1000).toFixed(1),
    sessions: (d.sessions ?? []).map((s) => {
      const mt = (s.media_type ?? '').toLowerCase()
      return {
        title: s.title ?? s.full_title ?? 'Unknown',
        user: s.user ?? s.username ?? 'unknown',
        state: s.state ?? '',
        progress: s.progress_percent ?? '',
        quality: s.quality_profile ?? '',
        verb: mt === 'track' || mt === 'music' ? 'listening to' : 'watching',
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function StatusDot({ active }) {
  return jsx('span', {
    style: {
      display: 'inline-block',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: active ? '#22c55e' : 'var(--ui-text-quaternary)',
      flexShrink: 0,
    },
  })
}

function Header({ streamCount, bandwidthMbps, active }) {
  return jsx('div', {
    className: 'flex items-center gap-2 px-3 py-2 text-sm font-medium',
    style: active ? { backgroundColor: 'rgba(34, 197, 94, 0.06)' } : undefined,
    children: jsxs('div', {
      className: 'flex items-center gap-2',
      children: [
        jsx(StatusDot, { active }),
        jsx('span', { children: 'Plex' }),
        active
          ? jsx('span', {
              className: 'ml-1 text-xs text-(--ui-text-tertiary)',
              children: `${streamCount} stream${streamCount !== 1 ? 's' : ''} · ${bandwidthMbps} Mbps`,
            })
          : null,
      ],
    }),
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
          jsx('span', {
            className: 'text-(--ui-text-tertiary)',
            children: `${session.user} ${session.verb} `,
          }),
          jsx('span', {
            className: 'font-medium',
            children: session.title,
          }),
        ],
      }),
      detail
        ? jsx('div', {
            className: 'text-(--ui-text-secondary)',
            children: detail,
          })
        : null,
    ],
  })
}

function PlexPane() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['plex', 'activity'],
    queryFn: fetchActivity,
    enabled: isConfigured,
    refetchInterval: POLL_MS,
    retry: false,
    staleTime: Math.floor(POLL_MS / 2),
  })

  // Not configured
  if (!isConfigured) {
    return jsxs('div', {
      className: 'flex h-full flex-col text-sm',
      children: [
        jsx(Header, { streamCount: 0, bandwidthMbps: '0', active: false }),
        jsx(Separator, {}),
        jsx('div', {
          className: 'px-3 py-4 text-xs text-(--ui-text-tertiary)',
          children: 'Set TAUTULLI_URL and TAUTULLI_API_KEY in the plugin file.',
        }),
      ],
    })
  }

  // Error
  if (error && !data) {
    return jsxs('div', {
      className: 'flex h-full flex-col text-sm',
      children: [
        jsx(Header, { streamCount: 0, bandwidthMbps: '0', active: false }),
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
        jsx(Header, { streamCount: 0, bandwidthMbps: '0', active: false }),
        jsx(Separator, {}),
        jsx('div', {
          className: 'px-3 py-4 text-xs text-(--ui-text-tertiary)',
          children: 'Connecting to Tautulli…',
        }),
      ],
    })
  }

  const { streamCount, bandwidthMbps, sessions } = data
  const active = streamCount > 0

  return jsxs('div', {
    className: 'flex h-full flex-col text-sm',
    children: [
      jsx(Header, { streamCount, bandwidthMbps, active }),
      jsx(Separator, {}),
      !active
        ? jsx('div', {
            className: 'px-3 py-4 text-xs text-(--ui-text-tertiary)',
            children: 'No active streams',
          })
        : jsx('div', {
            className: 'py-1',
            children: sessions.map((s, i) => jsx(SessionRow, { session: s }, i)),
          }),
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
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'plex status',
      data: { placement: 'right', width: '280px' },
      render: () => jsx(PlexPane, {}),
    })
  },
}
