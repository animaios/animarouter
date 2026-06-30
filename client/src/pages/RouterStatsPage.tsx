import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LiveEvents } from "@/components/live-events";
import { Tooltip as HoverTooltip } from "@/components/tooltip";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import { cn, formatIsoUtcToLocalChart, formatSqliteUtcToLocalTime } from "@/lib/utils";
import type {
  AnalyticsSummary,
  ErrorDistribution,
  ErrorEntry,
  ModelStats,
  ModelTimelineResponse,
  PlatformStats,
} from "../../../shared/types";
import {
  buildModelMixData,
  coerceModelTimeline,
  coerceRows,
  rankProductiveWindows,
  rebucketHourlyByLocal,
  type ModelMixData,
  type RebucketedHourlyStat,
} from "./router-stats-data";
import { HourlyProductivityChart } from "./HourlyProductivityChart";

type TimeRange = "15m" | "1h" | "24h" | "7d" | "30d";
type ChartInterval = "minute" | "5min" | "hour" | "day";
type ProviderBarKey = "requests" | "avgLatencyMs" | "count";
type ProviderBarDatum = {
  platform: string;
  requests?: number;
  avgLatencyMs?: number;
  count?: number;
};

const TIME_RANGES: TimeRange[] = ["15m", "1h", "24h", "7d", "30d"];
const RGB_MODE_STORAGE_KEY = "routerStatsRgbMode";
const ROUTER_STATS_COLORS = {
  requests: "var(--router-stat-green)",
  latency: "var(--router-stat-cyan)",
  errors: "var(--router-stat-red)",
} as const;

const chartTooltipStyle = {
  backgroundColor: "var(--popover)",
  border: "1px solid var(--router-stat-border)",
  borderRadius: 8,
  color: "var(--foreground)",
  fontSize: 12,
} as const;

function formatTokens(n?: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function rangeToInterval(range: TimeRange): ChartInterval {
  return range === "15m"
    ? "minute"
    : range === "1h"
      ? "5min"
      : range === "24h"
        ? "hour"
        : "day";
}

function getModelSeriesName(
  series: ModelTimelineResponse["series"][number],
): string {
  return series.platform
    ? `${series.displayName} (${series.platform})`
    : series.displayName;
}

function getInitialRgbMode() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return localStorage.getItem(RGB_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function useRouterStatsRgbMode() {
  const [enabled, setEnabled] = useState(getInitialRgbMode);

  function toggle() {
    setEnabled((current) => {
      const next = !current;
      try {
        localStorage.setItem(RGB_MODE_STORAGE_KEY, next ? "true" : "false");
      } catch {
        // Ignore storage failures; the toggle still works for this render.
      }
      return next;
    });
  }

  return { enabled, toggle };
}

function TimeRangeControl({
  range,
  onRangeChange,
}: {
  range: TimeRange;
  onRangeChange: (range: TimeRange) => void;
}) {
  return (
    <div className="router-stats-control flex gap-1 rounded-lg border p-0.5">
      {TIME_RANGES.map((r) => (
        <Button
          key={r}
          variant={range === r ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={range === r}
          onClick={() => onRangeChange(r)}
        >
          {r}
        </Button>
      ))}
    </div>
  );
}

function RgbModeToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      className="router-stats-rgb-toggle"
      variant={enabled ? "secondary" : "outline"}
      size="sm"
      type="button"
      aria-pressed={enabled}
      aria-label={enabled ? "Disable Router Stats RGB mode" : "Enable Router Stats RGB mode"}
      onClick={onToggle}
    >
      <Sparkles data-icon="inline-start" />
      RGB
    </Button>
  );
}

function MetricCard({
  label,
  value,
  hint,
  valueClassName,
}: {
  label: string;
  value: string | number;
  hint?: string;
  valueClassName?: string;
}) {
  const card = (
    <div className="router-stats-metric rounded-2xl border px-4 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-xl font-semibold tabular-nums",
          valueClassName,
        )}
      >
        {value}
      </p>
    </div>
  );

  return hint ? (
    <HoverTooltip text={hint} side="bottom" className="block">
      {card}
    </HoverTooltip>
  ) : (
    card
  );
}

export function ChartPanel({
  title,
  children,
  className,
  actions,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={cn("router-stats-panel rounded-2xl border", className)}>
      <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-3">
        <h3 className="min-w-0 truncate text-sm font-medium">{title}</h3>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>
  );
}

function colorForIndex(index: number) {
  const palette = [
    "var(--router-stat-green)",
    "var(--router-stat-cyan)",
    "var(--router-stat-magenta)",
    "var(--router-stat-yellow)",
    "var(--router-stat-red)",
  ];
  return palette[index % palette.length];
}

function TrafficMixStack({
  modelTimeline,
  data,
  hasData,
}: {
  modelTimeline: ModelTimelineResponse;
  data: Record<string, string | number>[];
  hasData: boolean;
}) {
  return (
    <ChartPanel title="Traffic Mix Over Time" className="lg:col-span-2">
      {!hasData ? (
        <EmptyState>No routed traffic in this range</EmptyState>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={340}>
            <AreaChart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--router-stat-grid)" />
              <XAxis
                dataKey="timestamp"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={{ stroke: "var(--router-stat-grid)" }}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip contentStyle={chartTooltipStyle} />
              {modelTimeline.series.map((series, index) => {
                const color = colorForIndex(index);
                return (
                  <Area
                    key={series.key}
                    type="monotone"
                    dataKey={series.key}
                    name={getModelSeriesName(series)}
                    stackId="models"
                    stroke={color}
                    fill={color}
                    fillOpacity={0.66}
                    strokeWidth={1.3}
                    dot={false}
                  />
                );
              })}
            </AreaChart>
          </ResponsiveContainer>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            {modelTimeline.series.map((series, index) => {
              const color = colorForIndex(index);
              const name = getModelSeriesName(series);
              return (
                <span key={series.key} className="inline-flex max-w-full items-center gap-1.5">
                  <span
                    className="size-2 rounded-sm"
                    style={{ backgroundColor: color }}
                  />
                  <span className="max-w-[220px] truncate" title={name}>
                    {name}
                  </span>
                </span>
              );
            })}
          </div>
        </>
      )}
    </ChartPanel>
  );
}

interface DonutDatum {
  id: string;
  label: string;
  provider?: string;
  requests: number;
  successRate?: number;
  fill: string;
}

function DonutTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: DonutDatum }>;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const datum = payload[0]?.payload;
  if (!datum) {
    return null;
  }

  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="font-medium">{datum.label}</p>
      {datum.provider && datum.provider !== datum.label && (
        <p className="mt-1 text-muted-foreground">{datum.provider}</p>
      )}
      <p className="mt-1 tabular-nums">{datum.requests.toLocaleString()} requests</p>
      {datum.successRate !== undefined && (
        <p className="text-muted-foreground tabular-nums">
          {datum.successRate}% success
        </p>
      )}
    </div>
  );
}

function ModelMixDonut({ data }: { data: ModelMixData }) {
  const providerData = useMemo<DonutDatum[]>(
    () =>
      data.providerRing.map((slice, index) => ({
        ...slice,
        fill: colorForIndex(index),
      })),
    [data.providerRing],
  );
  const modelData = useMemo<DonutDatum[]>(
    () =>
      data.modelRing.map((slice, index) => ({
        ...slice,
        fill: colorForIndex(index + 1),
      })),
    [data.modelRing],
  );
  const totalRequests = data.providerRing.reduce(
    (sum, slice) => sum + slice.requests,
    0,
  );

  return (
    <ChartPanel title="Provider / Model Mix">
      {providerData.length === 0 || modelData.length === 0 ? (
        <EmptyState>No model mix yet</EmptyState>
      ) : (
        <>
          <div className="relative">
            <ResponsiveContainer width="100%" height={320}>
              <PieChart>
                <Tooltip
                  content={({ active, payload }) => (
                    <DonutTooltip
                      active={active}
                      payload={payload as ReadonlyArray<{ payload?: DonutDatum }> | undefined}
                    />
                  )}
                />
                <Pie
                  data={providerData}
                  dataKey="requests"
                  nameKey="label"
                  innerRadius="38%"
                  outerRadius="56%"
                  paddingAngle={2}
                  stroke="var(--router-stat-panel)"
                  strokeWidth={2}
                >
                  {providerData.map((entry) => (
                    <Cell key={entry.id} fill={entry.fill} />
                  ))}
                </Pie>
                <Pie
                  data={modelData}
                  dataKey="requests"
                  nameKey="label"
                  innerRadius="64%"
                  outerRadius="84%"
                  paddingAngle={1}
                  stroke="var(--router-stat-panel)"
                  strokeWidth={2}
                >
                  {modelData.map((entry) => (
                    <Cell key={entry.id} fill={entry.fill} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <p className="text-2xl font-semibold tabular-nums">
                  {totalRequests.toLocaleString()}
                </p>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  requests
                </p>
              </div>
            </div>
          </div>
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-1">
            {modelData.slice(0, 6).map((slice) => (
              <div key={slice.id} className="flex min-w-0 items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-2 rounded-sm" style={{ backgroundColor: slice.fill }} />
                  <span className="truncate" title={slice.label}>
                    {slice.label}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{slice.requests}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </ChartPanel>
  );
}

function ProviderBars({
  title,
  data,
  dataKey,
  name,
  fill,
  unit,
  emptyText,
}: {
  title: string;
  data: ProviderBarDatum[];
  dataKey: ProviderBarKey;
  name: string;
  fill: string;
  unit?: string;
  emptyText: string;
}) {
  return (
    <ChartPanel title={title}>
      {data.length === 0 ? (
        <EmptyState>{emptyText}</EmptyState>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="2 4" stroke="var(--router-stat-grid)" />
            <XAxis
              dataKey="platform"
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--router-stat-grid)" }}
            />
            <YAxis
              unit={unit}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip contentStyle={chartTooltipStyle} />
            <Bar dataKey={dataKey} name={name} fill={fill} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartPanel>
  );
}

function ModelLeaderboard({
  rows,
  showPinnedCol,
}: {
  rows: ModelStats[];
  showPinnedCol: boolean;
}) {
  return (
    <ChartPanel title="Model Leaderboard">
      {rows.length === 0 ? (
        <EmptyState>No model mix yet</EmptyState>
      ) : (
        <div className="-mx-4 max-h-[420px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[220px] pl-4">Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                {showPinnedCol && <TableHead className="text-right">Pinned</TableHead>}
                <TableHead className="text-right">Success</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-right">
                  <HoverTooltip text="Output tokens + reasoning tokens per second. Reasoning tokens are included for fair comparison across model types.">
                    <span className="cursor-help underline decoration-dotted underline-offset-2">
                      Speed
                    </span>
                  </HoverTooltip>
                </TableHead>
                <TableHead className="text-right text-muted-foreground">In tokens</TableHead>
                <TableHead className="pr-4 text-right text-muted-foreground">
                  Out tokens
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={`${m.platform}:${m.modelId}`}>
                  <TableCell className="max-w-[280px] pl-4 text-sm font-medium">
                    <span className="block truncate" title={m.displayName}>
                      {m.displayName}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {m.platform}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.requests}
                  </TableCell>
                  {showPinnedCol && (
                    <TableCell className="text-right tabular-nums">
                      {m.pinnedRequests}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">
                    {m.successRate}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.avgLatencyMs} ms
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.tokPerSec > 0 ? `${m.tokPerSec} tok/s` : "—"}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {formatTokens(m.totalInputTokens)}
                  </TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">
                    {formatTokens(m.totalOutputTokens)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </ChartPanel>
  );
}

function RecentErrors({ errors }: { errors: ErrorEntry[] }) {
  return (
    <ChartPanel title="Recent errors">
      {errors.length === 0 ? (
        <EmptyState>No errors in this range</EmptyState>
      ) : (
        <div className="-mx-4 max-h-[420px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Provider</TableHead>
                <TableHead>Message</TableHead>
                <TableHead className="pr-4 text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {errors.slice(0, 20).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="pl-4 text-xs">{e.platform}</TableCell>
                  <TableCell className="max-w-[320px] text-xs">
                    <span className="block truncate" title={e.error ?? "Unknown error"}>
                      {e.error ?? "Unknown error"}
                    </span>
                  </TableCell>
                  <TableCell className="pr-4 text-right text-xs text-muted-foreground tabular-nums">
                    {formatSqliteUtcToLocalTime(e.createdAt, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </ChartPanel>
  );
}

export default function RouterStatsPage() {
  const [range, setRange] = useState<TimeRange>("24h");
  const rgbMode = useRouterStatsRgbMode();

  const { data: summary } = useQuery({
    queryKey: ["analytics", "summary", range],
    queryFn: () =>
      apiFetch<AnalyticsSummary>(`/api/analytics/summary?range=${range}`),
  });

  const { data: byPlatform } = useQuery({
    queryKey: ["analytics", "by-platform", range],
    queryFn: () =>
      apiFetch<PlatformStats[] | null>(
        `/api/analytics/by-platform?range=${range}`,
      ),
  });

  const { data: modelTimelineResponse } = useQuery({
    queryKey: ["analytics", "model-timeline", range],
    queryFn: () =>
      apiFetch<ModelTimelineResponse | null>(
        `/api/analytics/model-timeline?range=${range}`,
      ),
  });

  const { data: byModel } = useQuery({
    queryKey: ["analytics", "by-model", range],
    queryFn: () =>
      apiFetch<ModelStats[] | null>(`/api/analytics/by-model?range=${range}`),
  });

  const { data: errors = [] } = useQuery({
    queryKey: ["analytics", "errors", range],
    queryFn: () =>
      apiFetch<ErrorEntry[]>(`/api/analytics/errors?range=${range}`),
  });

  const { data: errorDist } = useQuery({
    queryKey: ["analytics", "error-distribution", range],
    queryFn: () =>
      apiFetch<ErrorDistribution>(
        `/api/analytics/error-distribution?range=${range}`,
      ),
  });

  const { data: hourlyResponse } = useQuery({
    queryKey: ["analytics", "hourly", range],
    queryFn: () =>
      apiFetch<RebucketedHourlyStat[]>(`/api/analytics/hourly?range=${range}`),
  });

  const utcOffsetMinutes = useMemo(
    () => new Date().getTimezoneOffset(),
    [],
  );

  const hourlyLocal = useMemo(
    () => rebucketHourlyByLocal(hourlyResponse, utcOffsetMinutes),
    [hourlyResponse, utcOffsetMinutes],
  );

  const hourlyWindows = useMemo(
    () => rankProductiveWindows(hourlyLocal),
    [hourlyLocal],
  );

  // Per-hour productivity score used for grade-coloring the bar chart.
  const hourlyScoreByHour = useMemo(() => {
    const maxLatency = Math.max(1, ...hourlyLocal.map((r) => r.avgLatencyMs));
    const map = new Map<number, number>();
    for (const r of hourlyLocal) {
      const latencyScore = (1 - r.avgLatencyMs / maxLatency) * 60;
      const successScore = (r.successRate / 100) * 30;
      const tokScore = Math.min(r.avgTokPerSec / 80, 1) * 10;
      map.set(r.hour, Math.round(latencyScore + successScore + tokScore));
    }
    return map;
  }, [hourlyLocal]);

  const modelTimeline = useMemo(
    () => coerceModelTimeline(modelTimelineResponse),
    [modelTimelineResponse],
  );

  const formattedModelTimeline = useMemo(
    () =>
      modelTimeline.points.map((d): Record<string, string | number> => {
        const base: Record<string, string | number> = { ...d };
        return {
          ...base,
          timestamp: formatIsoUtcToLocalChart(
            String(d.timestamp),
            rangeToInterval(range),
          ),
        };
      }),
    [modelTimeline.points, range],
  );
  const hasModelTimelineData =
    modelTimeline.series.length > 0 &&
    formattedModelTimeline.some((d) => Number(d.totalRequests ?? 0) > 0);

  const modelLeaderboard = useMemo(
    () => [...coerceRows(byModel)].sort((a, b) => b.requests - a.requests),
    [byModel],
  );
  const showPinnedCol = useMemo(
    () => modelLeaderboard.some((m) => m.pinnedRequests > 0),
    [modelLeaderboard],
  );
  const modelMixData = useMemo(
    () => buildModelMixData(modelLeaderboard, { maxModels: 10 }),
    [modelLeaderboard],
  );
  const providerByRequests = useMemo(
    () => [...coerceRows(byPlatform)].sort((a, b) => b.requests - a.requests),
    [byPlatform],
  );
  const providerByLatency = useMemo(
    () =>
      [...coerceRows(byPlatform)].sort(
        (a, b) => b.avgLatencyMs - a.avgLatencyMs,
      ),
    [byPlatform],
  );
  const errorByProvider = useMemo(
    () => [...(errorDist?.byPlatform ?? [])].sort((a, b) => b.count - a.count),
    [errorDist?.byPlatform],
  );

  const pinned = summary?.pinnedRequests ?? 0;
  const pinHonored = summary?.pinHonoredRequests ?? 0;
  const requestsHint =
    pinned > 0
      ? `${pinned} of these requests pinned a specific model by name. ${pinHonored} were served by the pinned model; ${pinned - pinHonored} failed over to a different one. The rest were auto-routed.`
      : "All requests in this period were auto-routed; no client pinned a specific model by name.";

  return (
    <div className={cn("router-stats space-y-6", rgbMode.enabled && "rgb-mode")}>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Router Stats</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Provider traffic, model mix, latency, and routing failures.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TimeRangeControl range={range} onRangeChange={setRange} />
          <RgbModeToggle enabled={rgbMode.enabled} onToggle={rgbMode.toggle} />
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MetricCard
          label="Requests"
          value={summary?.totalRequests ?? 0}
          hint={requestsHint}
        />
        <MetricCard label="Success rate" value={`${summary?.successRate ?? 0}%`} />
        <MetricCard
          label="Input tokens"
          value={formatTokens(summary?.totalInputTokens)}
        />
        <MetricCard
          label="Output tokens"
          value={formatTokens(summary?.totalOutputTokens)}
        />
        <MetricCard label="Avg latency" value={`${summary?.avgLatencyMs ?? 0} ms`} />
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <HourlyProductivityChart
          rows={hourlyLocal}
          windows={hourlyWindows}
          scoreByHour={hourlyScoreByHour}
        />
        <ModelMixDonut data={modelMixData} />
      </section>

      <section>
        <TrafficMixStack
          modelTimeline={modelTimeline}
          data={formattedModelTimeline}
          hasData={hasModelTimelineData}
        />
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ProviderBars
          title="Requests by provider"
          data={providerByRequests}
          dataKey="requests"
          name="Requests"
          fill={ROUTER_STATS_COLORS.requests}
          emptyText="No routed traffic in this range"
        />
        <ProviderBars
          title="Avg latency by provider"
          data={providerByLatency}
          dataKey="avgLatencyMs"
          name="Latency (ms)"
          fill={ROUTER_STATS_COLORS.latency}
          unit="ms"
          emptyText="No routed traffic in this range"
        />
        <ProviderBars
          title="Errors by provider"
          data={errorByProvider}
          dataKey="count"
          name="Errors"
          fill={ROUTER_STATS_COLORS.errors}
          emptyText="No errors in this range"
        />
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Live Feed</h2>
        </div>
        <div className="router-stats-live-feed">
          <LiveEvents />
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)]">
        <ModelLeaderboard rows={modelLeaderboard} showPinnedCol={showPinnedCol} />
        <RecentErrors errors={errors} />
      </section>
    </div>
  );
}
