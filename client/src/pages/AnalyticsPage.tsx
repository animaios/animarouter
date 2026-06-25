import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import type { AnalyticsSummary, PlatformStats, TimelinePoint, ModelStats, ErrorEntry, ErrorDistribution } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import { LiveEvents } from '@/components/live-events';
import { Tooltip as HoverTooltip } from '@/components/tooltip'
import { formatSqliteUtcToLocalTime, formatIsoUtcToLocalChart } from '@/lib/utils'

type TimeRange = '15m' | '1h' | '24h' | '7d' | '30d'

function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function Stat({ label, value, hint, className }: { label: string; value: string | number; hint?: string; className?: string }) {
  const card = (
    <div className="rounded-3xl border bg-card px-4 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ''}`}>{value}</p>
    </div>
  )
  // Same portal tooltip as the routing strategy chips. Opens BELOW the card:
  // the stats row sits right under the sticky navbar.
  return hint ? <HoverTooltip text={hint} side="bottom" className="block">{card}</HoverTooltip> : card
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border bg-card">
      <div className="px-4 py-3 border-b">
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'

export default function AnalyticsPage() {
  const [range, setRange] = useState<TimeRange>('24h')

  const { data: summary } = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => apiFetch<AnalyticsSummary>(`/api/analytics/summary?range=${range}`),
  })

  const { data: byPlatform = [] } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<PlatformStats[]>(`/api/analytics/by-platform?range=${range}`),
  })

  const { data: timeline = [] } = useQuery({
    queryKey: ['analytics', 'timeline', range],
    queryFn: () => apiFetch<TimelinePoint[]>(`/api/analytics/timeline?range=${range}`),
  })

  // Format timeline timestamps in local time before they reach Recharts.
  const formattedTimeline = useMemo(() =>
    timeline.map((d) => ({
      ...d,
      timestamp: formatIsoUtcToLocalChart(
        d.timestamp,
        range === '15m' ? 'minute' :
        range === '1h'  ? '5min'  :
        range === '24h' ? 'hour'  : 'day',
      ),
    })),
    [timeline, range],
  );

  const { data: byModel = [] } = useQuery({
    queryKey: ['analytics', 'by-model', range],
    queryFn: () => apiFetch<ModelStats[]>(`/api/analytics/by-model?range=${range}`),
  })

  // Only show the Pinned column when at least one model has pinned requests.
  const showPinnedCol = useMemo(() => byModel.some(m => m.pinnedRequests > 0), [byModel])

  const { data: errors = [] } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<ErrorEntry[]>(`/api/analytics/errors?range=${range}`),
  })

  const { data: errorDist } = useQuery({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: () => apiFetch<ErrorDistribution>(`/api/analytics/error-distribution?range=${range}`),
  })

  // Pinned = the client named a specific model instead of auto-routing.
  // Honored = that model actually served it (the rest failed over).
  const pinned = summary?.pinnedRequests ?? 0
  const pinHonored = summary?.pinHonoredRequests ?? 0
  const requestsHint = pinned > 0
    ? `${pinned} of these requests pinned a specific model by name. ${pinHonored} were served by the pinned model; ${pinned - pinHonored} failed over to a different one. The rest were auto-routed.`
    : 'All requests in this period were auto-routed; no client pinned a specific model by name.'

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Request volume, latency, token usage, and failures."
        actions={
          <div className="flex gap-1 rounded-lg border p-0.5">
            {(['15m', '1h', '24h', '7d', '30d'] as TimeRange[]).map(r => (
              <Button
                key={r}
                variant={range === r ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setRange(r)}
              >
                {r}
              </Button>
            ))}
          </div>
        }
      />
      <div className="space-y-6">
        {/* Live routing feed — real-time visibility into proxy decisions */}
        <LiveEvents />

        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Stat label="Requests" value={summary?.totalRequests ?? 0} hint={requestsHint} />
          <Stat label="Success rate" value={`${summary?.successRate ?? 0}%`} />
          <Stat label="Input tokens" value={formatTokens(summary?.totalInputTokens)} />
          <Stat label="Output tokens" value={formatTokens(summary?.totalOutputTokens)} />
          <Stat label="Avg latency" value={`${summary?.avgLatencyMs ?? 0} ms`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel title="Requests by provider">
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="requests" fill={primaryFill} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title="Avg latency by provider">
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="avgLatencyMs" name="Latency (ms)" fill="var(--muted-foreground)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Requests over time">
              {formattedTimeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={formattedTimeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name="Success" stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name="Failures" stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel title="Per-model breakdown">
              {byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">Model</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        {showPinnedCol && <TableHead className="text-right">Pinned</TableHead>}
                        <TableHead className="text-right">Success</TableHead>
                        <TableHead className="text-right">Latency</TableHead>
                        <TableHead className="text-right"><HoverTooltip text="Output tokens + reasoning tokens per second. Reasoning tokens are included for fair comparison across model types."><span className="underline decoration-dotted underline-offset-2 cursor-help">Speed</span></HoverTooltip></TableHead>
                        <TableHead className="text-right">In tokens</TableHead>
                        <TableHead className="text-right pr-4">Out tokens</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byModel.map((m, i: number) => (
                        <TableRow key={i}>
                          <TableCell className="pl-4 text-sm font-medium">{m.displayName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.platform}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                          {showPinnedCol && <TableCell className="text-right tabular-nums">{m.pinnedRequests}</TableCell>}
                          <TableCell className="text-right tabular-nums">{m.successRate}%</TableCell>
                          <TableCell className="text-right tabular-nums">{m.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{m.tokPerSec > 0 ? `${m.tokPerSec} tok/s` : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">{formatTokens(m.totalOutputTokens)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Errors by provider">
            {!errorDist?.byPlatform?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">No errors</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" fill="var(--destructive)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title="Recent errors">
            {errors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No errors</p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Provider</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead className="text-right pr-4">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.slice(0, 20).map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="pl-4 text-xs">{e.platform}</TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">{e.error}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-4">
                          {formatSqliteUtcToLocalTime(e.createdAt, { hour: '2-digit', minute: '2-digit' })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
