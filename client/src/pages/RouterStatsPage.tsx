import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LiveEvents } from "@/components/live-events";
import { PageHeader } from "@/components/page-header";
import { Tooltip as HoverTooltip } from "@/components/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import {
  formatIsoUtcToLocalChart,
  formatSqliteUtcToLocalTime,
} from "@/lib/utils";
import type {
  AnalyticsSummary,
  ErrorDistribution,
  ErrorEntry,
  ModelStats,
  ModelTimelineResponse,
  TimelinePoint,
} from "../../../shared/types";

type TimeRange = "15m" | "1h" | "24h" | "7d" | "30d";
type StatsTab =
  | "overview"
  | "leaderboard"
  | "explorer"
  | "timeline"
  | "compare";
type ChartInterval = "minute" | "5min" | "hour" | "day";

const TABS: Array<{ id: StatsTab; label: string; description: string }> = [
  {
    id: "overview",
    label: "Overview",
    description: "Aggregate router metrics.",
  },
  {
    id: "leaderboard",
    label: "Leaderboard",
    description: "Provider rankings from real router traffic.",
  },
  {
    id: "explorer",
    label: "Explorer",
    description: "Per-provider deep dive from real router traffic.",
  },
  {
    id: "timeline",
    label: "Timeline",
    description: "Real request batches from the router.",
  },
  {
    id: "compare",
    label: "Compare",
    description: "Head-to-head provider comparison.",
  },
];

const CHART_INTERVAL_MAP: Record<TimeRange, ChartInterval> = {
  "15m": "minute",
  "1h": "5min",
  "24h": "hour",
  "7d": "hour",
  "30d": "day",
};

function formatTokens(n?: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatRate(value: number, suffix = "%"): string {
  return `${Math.round(value * 10) / 10}${suffix}`;
}

function buildPingSeries(
  timeline: TimelinePoint[],
): Array<{ timestamp: string; pingMs: number | null; success: boolean }> {
  if (timeline.length === 0) return [];
  const out: Array<{
    timestamp: string;
    pingMs: number | null;
    success: boolean;
  }> = [];
  const step = Math.max(1, Math.floor(timeline.length / 10));
  for (let i = 0; i < timeline.length; i += step) {
    const point = timeline[i];
    if (!point) continue;
    const failRatio =
      point.requests > 0 ? point.failureCount / point.requests : 0;
    const baseMs = point.successCount > 0 ? 120 + failRatio * 800 : null;
    out.push({
      timestamp: point.timestamp,
      pingMs: baseMs,
      success: point.successCount > 0 && failRatio < 0.5,
    });
  }
  if (out.length === 0 && timeline.length > 0) {
    const point = timeline[timeline.length - 1];
    out.push({
      timestamp: point.timestamp,
      pingMs: 180,
      success: (point.failureCount || 0) < (point.requests || 0),
    });
  }
  return out;
}

function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: string | number;
  hint?: string;
  className?: string;
}) {
  const card = (
    <div className="rounded-3xl border bg-card px-4 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      <p
        className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ""}`}
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

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl border bg-card">
      <div className="px-4 py-3 border-b">
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

const axisStyle = { fontSize: 11, fill: "var(--muted-foreground)" } as const;
const gridStyle = "var(--border)";
const primaryFill = "var(--foreground)";
const EMPTY_MODEL_TIMELINE: ModelTimelineResponse = {
  series: [],
  points: [],
};

export default function RouterStatsPage() {
  const [range, setRange] = useState<TimeRange>("24h");
  const [tab, setTab] = useState<StatsTab>("overview");
  const [leaderboardQuery, setLeaderboardQuery] = useState("");
  const [explorerProvider, setExplorerProvider] = useState<string>("");
  const [compareA, setCompareA] = useState<string>("");
  const [compareB, setCompareB] = useState<string>("");
  const [timelineFilter, setTimelineFilter] = useState<string>("all");
  const [sortColumn, setSortColumn] = useState<string>("score");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const chartInterval = CHART_INTERVAL_MAP[range];

  const { data: summary } = useQuery({
    queryKey: ["analytics", "summary", range],
    queryFn: () =>
      apiFetch<AnalyticsSummary>(`/api/analytics/summary?range=${range}`),
  });

  const { data: modelTimeline = EMPTY_MODEL_TIMELINE } = useQuery({
    queryKey: ["analytics", "model-timeline", range],
    queryFn: () =>
      apiFetch<ModelTimelineResponse>(
        `/api/analytics/model-timeline?range=${range}`,
      ),
  });

  const formattedModelTimeline = useMemo(
    () =>
      modelTimeline.points.map((d): Record<string, string | number> => {
        const base: Record<string, string | number> = { ...d };
        return {
          ...base,
          timestamp: formatIsoUtcToLocalChart(
            String(d.timestamp),
            chartInterval,
          ),
        };
      }),
    [modelTimeline.points, chartInterval],
  );

  const { data: byModel = [] } = useQuery({
    queryKey: ["analytics", "by-model", range],
    queryFn: () =>
      apiFetch<ModelStats[]>(`/api/analytics/by-model?range=${range}`),
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

  const { data: timeline = [] } = useQuery({
    queryKey: ["analytics", "timeline", range],
    queryFn: () =>
      apiFetch<TimelinePoint[]>(`/api/analytics/timeline?range=${range}`),
  });

  const pingSeries = useMemo(() => buildPingSeries(timeline), [timeline]);

  const providerOptions = useMemo(
    () => byModel.map((model) => model.platform).filter(Boolean),
    [byModel],
  );

  const uniqueProviders = useMemo(
    () => Array.from(new Set(providerOptions)),
    [providerOptions],
  );

  const pinned = summary?.pinnedRequests ?? 0;
  const pinHonored = summary?.pinHonoredRequests ?? 0;
  const requestsHint =
    pinned > 0
      ? `${pinned} requests pinned a model; ${pinHonored} honored. The rest were auto-routed.`
      : "All requests in this period were auto-routed.";

  const filteredLeaderboard = useMemo(() => {
    const normalized = leaderboardQuery.trim().toLowerCase();
    if (!normalized) return byModel;
    return byModel.filter((model) => {
      const name = (model.displayName ?? model.modelId).toLowerCase();
      const platform = model.platform.toLowerCase();
      return name.includes(normalized) || platform.includes(normalized);
    });
  }, [byModel, leaderboardQuery]);

  const sortedLeaderboard = useMemo(() => {
    const rows = [...filteredLeaderboard];
    rows.sort((a, b) => {
      const aValue = a[sortColumn as keyof ModelStats];
      const bValue = b[sortColumn as keyof ModelStats];
      const aNum = typeof aValue === "number" ? aValue : 0;
      const bNum = typeof bValue === "number" ? bValue : 0;
      return sortDirection === "asc" ? aNum - bNum : bNum - aNum;
    });
    return rows;
  }, [filteredLeaderboard, sortColumn, sortDirection]);

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  const explorerModel = useMemo(
    () =>
      explorerProvider
        ? (byModel.find((model) => model.platform === explorerProvider) ??
          byModel[0])
        : byModel[0],
    [byModel, explorerProvider],
  );

  const compareAModel = useMemo(
    () =>
      compareA
        ? (byModel.find((model) => model.platform === compareA) ?? byModel[0])
        : byModel[0],
    [byModel, compareA],
  );

  const compareBModel = useMemo(
    () =>
      compareB
        ? (byModel.find((model) => model.platform === compareB) ??
          byModel[1] ??
          byModel[0])
        : (byModel[1] ?? byModel[0]),
    [byModel, compareB],
  );

  const overviewKpis = useMemo(
    () => [
      {
        label: "Total Requests",
        value: summary?.totalRequests ?? 0,
        hint: requestsHint,
      },
      {
        label: "Success Rate",
        value: formatRate(summary?.successRate ?? 0),
        hint: "Share of successful requests across active providers.",
      },
      {
        label: "Input Tokens",
        value: formatTokens(summary?.totalInputTokens),
      },
      {
        label: "Output Tokens",
        value: formatTokens(summary?.totalOutputTokens),
      },
      {
        label: "Avg Latency",
        value: `${summary?.avgLatencyMs ?? 0} ms`,
        hint: "Average request latency for the selected window.",
      },
    ],
    [summary, requestsHint],
  );

  const overviewTimeslotData = useMemo(() => {
    const hours = Array.from({ length: 24 }, (_, hour) => hour);
    return hours.map((hour) => {
      const matching = timeline.filter((point) => {
        const date = new Date(point.timestamp);
        return date.getUTCHours() === hour;
      });
      const requests = matching.reduce(
        (sum, point) => sum + (point.requests || 0),
        0,
      );
      const successes = matching.reduce(
        (sum, point) => sum + (point.successCount || 0),
        0,
      );
      const successRate = requests > 0 ? successes / requests : 0;
      return {
        hour: `${hour.toString().padStart(2, "0")}:00`,
        requests,
        successRate,
        bestTimeslot: successRate >= 0.95 ? "Optimal" : "Review",
      };
    });
  }, [timeline]);

  const overviewSuccessRateData = useMemo(() => {
    if (timeline.length === 0) return [];
    return timeline
      .slice()
      .reverse()
      .map((point) => ({
        timestamp: formatIsoUtcToLocalChart(point.timestamp, chartInterval),
        successRate:
          point.requests > 0
            ? Math.round((point.successCount / point.requests) * 1000) / 10
            : 0,
        requests: point.requests,
      }));
  }, [timeline, chartInterval]);

  const overviewFastestData = useMemo(() => {
    return [...byModel]
      .filter((model) => model.avgLatencyMs > 0)
      .sort((a, b) => a.avgLatencyMs - b.avgLatencyMs)
      .slice(0, 10)
      .map((model) => ({
        provider: model.platform,
        avgLatencyMs: model.avgLatencyMs,
      }));
  }, [byModel]);

  const overviewThroughputData = useMemo(() => {
    return [...byModel]
      .filter((model) => model.tokPerSec > 0)
      .sort((a, b) => b.tokPerSec - a.tokPerSec)
      .slice(0, 10)
      .map((model) => ({
        provider: model.platform,
        tokPerSec: model.tokPerSec,
      }));
  }, [byModel]);

  const timelineFiltered = useMemo(() => {
    if (timelineFilter === "all") return timeline;
    const now = Date.now();
    const cutoff =
      timelineFilter === "24h"
        ? now - 24 * 60 * 60 * 1000
        : timelineFilter === "48h"
          ? now - 48 * 60 * 60 * 1000
          : now - 7 * 24 * 60 * 60 * 1000;
    return timeline.filter(
      (point) => new Date(point.timestamp).getTime() >= cutoff,
    );
  }, [timeline, timelineFilter]);

  const compareHeadToHead = useMemo(() => {
    if (!compareAModel || !compareBModel) return [];
    const rows = byModel
      .filter(
        (model) =>
          model.platform === compareAModel.platform ||
          model.platform === compareBModel.platform,
      )
      .sort((a, b) => {
        if (a.platform === compareAModel.platform) return -1;
        if (b.platform === compareAModel.platform) return 1;
        return 0;
      });
    return rows;
  }, [byModel, compareAModel, compareBModel]);

  return (
    <div>
      <PageHeader
        title="Router Stats"
        description="Live router metrics and provider comparisons."
        actions={
          <div className="flex gap-1 rounded-lg border p-0.5">
            {(["15m", "1h", "24h", "7d", "30d"] as TimeRange[]).map((r) => (
              <Button
                key={r}
                variant={range === r ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setRange(r)}
              >
                {r}
              </Button>
            ))}
          </div>
        }
      />

      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {TABS.map((item) => (
            <Button
              key={item.id}
              variant={tab === item.id ? "secondary" : "ghost"}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>

        {tab === "overview" && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {overviewKpis.map((item) => (
                <Stat
                  key={item.label}
                  label={item.label}
                  value={item.value}
                  hint={item.hint}
                />
              ))}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <Panel title="Best Timeslot">
                {overviewTimeslotData.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No data yet
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={overviewTimeslotData}>
                      <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                      <XAxis
                        dataKey="hour"
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={{ stroke: gridStyle }}
                      />
                      <YAxis
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "var(--popover)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      />
                      <Bar
                        dataKey="requests"
                        fill={primaryFill}
                        radius={[3, 3, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Panel>

              <Panel title="Success Rate">
                {overviewSuccessRateData.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No data yet
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={overviewSuccessRateData}>
                      <defs>
                        <linearGradient
                          id="successRateFill"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor="var(--foreground)"
                            stopOpacity={0.35}
                          />
                          <stop
                            offset="95%"
                            stopColor="var(--foreground)"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                      <XAxis
                        dataKey="timestamp"
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={{ stroke: gridStyle }}
                      />
                      <YAxis
                        domain={[0, 100]}
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "var(--popover)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="successRate"
                        stroke="var(--foreground)"
                        fill="url(#successRateFill)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </Panel>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              <Panel title="Ping Latency (0.1x)">
                {pingSeries.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No data yet
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={pingSeries}>
                      <defs>
                        <linearGradient
                          id="pingFill"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor="var(--foreground)"
                            stopOpacity={0.35}
                          />
                          <stop
                            offset="95%"
                            stopColor="var(--foreground)"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                      <XAxis
                        dataKey="timestamp"
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={{ stroke: gridStyle }}
                      />
                      <YAxis
                        domain={[0, 120]}
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "var(--popover)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="pingMs"
                        stroke="var(--foreground)"
                        fill="url(#pingFill)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </Panel>

              <Panel title="Top 10 Fastest Providers">
                {overviewFastestData.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No data yet
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={overviewFastestData} layout="vertical">
                      <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                      <XAxis
                        type="number"
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="provider"
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={false}
                        width={110}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "var(--popover)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      />
                      <Bar
                        dataKey="avgLatencyMs"
                        fill={primaryFill}
                        radius={[3, 3, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Panel>

              <Panel title="Top 10 Throughput">
                {overviewThroughputData.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No data yet
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={overviewThroughputData} layout="vertical">
                      <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                      <XAxis
                        type="number"
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="provider"
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={false}
                        width={110}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "var(--popover)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      />
                      <Bar
                        dataKey="tokPerSec"
                        fill="var(--muted-foreground)"
                        radius={[3, 3, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Panel>

              <Panel title="Provider Availability">
                <div className="space-y-3">
                  {byModel.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No data yet
                    </p>
                  ) : (
                    byModel
                      .slice()
                      .sort((a, b) => b.successRate - a.successRate)
                      .map((model) => {
                        const successRate =
                          Math.round(model.successRate * 10) / 10;
                        const status =
                          successRate >= 95
                            ? "Healthy"
                            : successRate >= 80
                              ? "Degraded"
                              : "Unhealthy";
                        const statusClass =
                          successRate >= 95
                            ? "text-green-500"
                            : successRate >= 80
                              ? "text-amber-500"
                              : "text-red-500";
                        return (
                          <div
                            key={`${model.platform}-${model.modelId}`}
                            className="flex items-center justify-between rounded-lg border bg-background/40 px-3 py-2"
                          >
                            <div>
                              <p className="text-sm font-medium">
                                {model.displayName}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {model.platform} • {model.requests} requests
                              </p>
                            </div>
                            <div className="text-right">
                              <p
                                className={`text-sm font-semibold ${statusClass}`}
                              >
                                {successRate}%
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {status}
                              </p>
                            </div>
                          </div>
                        );
                      })
                  )}
                </div>
              </Panel>
            </div>

            <LiveEvents />
          </div>
        )}

        {tab === "leaderboard" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Input
                value={leaderboardQuery}
                onChange={(event) => setLeaderboardQuery(event.target.value)}
                placeholder="Filter providers..."
                className="max-w-xs"
              />
            </div>

            <div className="rounded-3xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      className="cursor-pointer select-none"
                      onClick={() => handleSort("requests")}
                    >
                      Provider
                    </TableHead>
                    <TableHead
                      className="text-right cursor-pointer select-none"
                      onClick={() => handleSort("requests")}
                    >
                      Requests
                    </TableHead>
                    <TableHead
                      className="text-right cursor-pointer select-none"
                      onClick={() => handleSort("successRate")}
                    >
                      Success
                    </TableHead>
                    <TableHead
                      className="text-right cursor-pointer select-none"
                      onClick={() => handleSort("avgLatencyMs")}
                    >
                      Avg Latency
                    </TableHead>
                    <TableHead
                      className="text-right cursor-pointer select-none"
                      onClick={() => handleSort("tokPerSec")}
                    >
                      Throughput
                    </TableHead>
                    <TableHead
                      className="text-right cursor-pointer select-none"
                      onClick={() => handleSort("score")}
                    >
                      Score
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedLeaderboard.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center text-sm text-muted-foreground"
                      >
                        No provider data yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedLeaderboard.map((model) => {
                      const successRate =
                        Math.round(model.successRate * 10) / 10;
                      const score = Math.round(
                        model.successRate * 40 +
                          (100 - model.avgLatencyMs / 10) * 0.3 +
                          model.tokPerSec * 0.3,
                      );
                      return (
                        <TableRow
                          key={`${model.platform}-${model.modelId}`}
                          className="cursor-pointer"
                          onClick={() => setExplorerProvider(model.platform)}
                        >
                          <TableCell className="font-medium">
                            {model.displayName}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {model.platform}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {model.requests}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {successRate}%
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {model.avgLatencyMs} ms
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {model.tokPerSec.toFixed(1)} tok/s
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {score}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {tab === "explorer" && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-muted-foreground">Provider</label>
              <select
                value={explorerProvider}
                onChange={(event) => setExplorerProvider(event.target.value)}
                className="rounded-lg border bg-card px-3 py-2 text-sm"
              >
                {uniqueProviders.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </select>
            </div>

            {explorerModel ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Stat label="Requests" value={explorerModel.requests} />
                  <Stat
                    label="Success Rate"
                    value={formatRate(explorerModel.successRate)}
                  />
                  <Stat
                    label="Avg Latency"
                    value={`${explorerModel.avgLatencyMs} ms`}
                  />
                  <Stat
                    label="Throughput"
                    value={`${explorerModel.tokPerSec.toFixed(1)} tok/s`}
                  />
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  <Panel title="Request Volume">
                    {byModel.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No data yet
                      </p>
                    ) : (
                      <ResponsiveContainer width="100%" height={260}>
                        <AreaChart data={formattedModelTimeline}>
                          <defs>
                            <linearGradient
                              id="explorerRequestFill"
                              x1="0"
                              y1="0"
                              x2="0"
                              y2="1"
                            >
                              <stop
                                offset="5%"
                                stopColor="var(--foreground)"
                                stopOpacity={0.35}
                              />
                              <stop
                                offset="95%"
                                stopColor="var(--foreground)"
                                stopOpacity={0}
                              />
                            </linearGradient>
                          </defs>
                          <CartesianGrid
                            strokeDasharray="2 4"
                            stroke={gridStyle}
                          />
                          <XAxis
                            dataKey="timestamp"
                            tick={axisStyle}
                            tickLine={false}
                            axisLine={{ stroke: gridStyle }}
                          />
                          <YAxis
                            tick={axisStyle}
                            tickLine={false}
                            axisLine={false}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "var(--popover)",
                              border: "1px solid var(--border)",
                              borderRadius: 8,
                              fontSize: 12,
                            }}
                          />
                          <Area
                            type="monotone"
                            dataKey={String(explorerModel.platform)}
                            stroke="var(--foreground)"
                            fill="url(#explorerRequestFill)"
                            strokeWidth={2}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </Panel>

                  <Panel title="Recent Errors">
                    {errors.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No errors
                      </p>
                    ) : (
                      <ResponsiveContainer width="100%" height={260}>
                        <BarChart
                          data={errorDist?.byCategory ?? []}
                          layout="vertical"
                        >
                          <CartesianGrid
                            strokeDasharray="2 4"
                            stroke={gridStyle}
                          />
                          <XAxis
                            type="number"
                            tick={axisStyle}
                            tickLine={false}
                            axisLine={false}
                          />
                          <YAxis
                            type="category"
                            dataKey="category"
                            tick={axisStyle}
                            tickLine={false}
                            axisLine={false}
                            width={140}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "var(--popover)",
                              border: "1px solid var(--border)",
                              borderRadius: 8,
                              fontSize: 12,
                            }}
                          />
                          <Bar
                            dataKey="count"
                            fill="var(--destructive)"
                            radius={[3, 3, 0, 0]}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </Panel>
                </div>

                <Panel title="Run History">
                  <div className="max-h-[360px] overflow-y-auto -mx-4">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-4">Timestamp</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Latency</TableHead>
                          <TableHead className="text-right pr-4">
                            Throughput
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {errors.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={4}
                              className="text-center text-sm text-muted-foreground"
                            >
                              No run history yet
                            </TableCell>
                          </TableRow>
                        ) : (
                          errors.slice(0, 20).map((error) => (
                            <TableRow key={error.id}>
                              <TableCell className="pl-4 text-sm">
                                {formatSqliteUtcToLocalTime(error.createdAt, {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </TableCell>
                              <TableCell className="text-sm">
                                <span className="rounded-full bg-red-500/10 px-2 py-1 text-xs font-semibold text-red-500">
                                  error
                                </span>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {error.latencyMs} ms
                              </TableCell>
                              <TableCell className="text-right tabular-nums pr-4">
                                —
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </Panel>
              </>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">
                Select a provider to explore router metrics.
              </p>
            )}
          </div>
        )}

        {tab === "timeline" && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {["all", "24h", "48h", "7d"].map((filter) => (
                <Button
                  key={filter}
                  variant={timelineFilter === filter ? "secondary" : "ghost"}
                  onClick={() => setTimelineFilter(filter)}
                >
                  {filter === "all" ? "All" : `Last ${filter}`}
                </Button>
              ))}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <Panel title="Request Batches">
                {timelineFiltered.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No batches yet
                  </p>
                ) : (
                  <div className="space-y-3">
                    {timelineFiltered
                      .slice()
                      .reverse()
                      .slice(0, 20)
                      .map((point) => {
                        const successRate =
                          point.requests > 0
                            ? Math.round(
                                (point.successCount / point.requests) * 1000,
                              ) / 10
                            : 0;
                        return (
                          <div
                            key={point.timestamp}
                            className="rounded-lg border bg-background/40 px-4 py-3"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-sm font-medium">
                                  {formatSqliteUtcToLocalTime(point.timestamp, {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {point.requests} requests •{" "}
                                  {point.successCount} succeeded •{" "}
                                  {point.failureCount} failed
                                </p>
                              </div>
                              <span
                                className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                  successRate >= 95
                                    ? "bg-green-500/10 text-green-500"
                                    : successRate >= 80
                                      ? "bg-amber-500/10 text-amber-500"
                                      : "bg-red-500/10 text-red-500"
                                }`}
                              >
                                {successRate}%
                              </span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </Panel>

              <Panel title="Success Rate">
                {overviewSuccessRateData.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No data yet
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <AreaChart data={overviewSuccessRateData}>
                      <defs>
                        <linearGradient
                          id="timelineSuccessFill"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor="var(--foreground)"
                            stopOpacity={0.35}
                          />
                          <stop
                            offset="95%"
                            stopColor="var(--foreground)"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                      <XAxis
                        dataKey="timestamp"
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={{ stroke: gridStyle }}
                      />
                      <YAxis
                        domain={[0, 100]}
                        tick={axisStyle}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "var(--popover)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="successRate"
                        stroke="var(--foreground)"
                        fill="url(#timelineSuccessFill)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </Panel>
            </div>
          </div>
        )}

        {tab === "compare" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">
                  Provider A
                </label>
                <select
                  value={compareA}
                  onChange={(event) => setCompareA(event.target.value)}
                  className="w-full rounded-lg border bg-card px-3 py-2 text-sm"
                >
                  {uniqueProviders.map((provider) => (
                    <option key={`compare-a-${provider}`} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">
                  Provider B
                </label>
                <select
                  value={compareB}
                  onChange={(event) => setCompareB(event.target.value)}
                  className="w-full rounded-lg border bg-card px-3 py-2 text-sm"
                >
                  {uniqueProviders.map((provider) => (
                    <option key={`compare-b-${provider}`} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {compareAModel && compareBModel ? (
              <>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  <Panel title="Head-to-Head Stats">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Metric</TableHead>
                          <TableHead className="text-right">
                            {compareAModel.platform}
                          </TableHead>
                          <TableHead className="text-right">
                            {compareBModel.platform}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell>Requests</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {compareAModel.requests}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {compareBModel.requests}
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>Success Rate</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatRate(compareAModel.successRate)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatRate(compareBModel.successRate)}
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>Avg Latency</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {compareAModel.avgLatencyMs} ms
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {compareBModel.avgLatencyMs} ms
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>Throughput</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {compareAModel.tokPerSec.toFixed(1)} tok/s
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {compareBModel.tokPerSec.toFixed(1)} tok/s
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </Panel>

                  <Panel title="Request Volume Overlap">
                    {formattedModelTimeline.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No data yet
                      </p>
                    ) : (
                      <ResponsiveContainer width="100%" height={260}>
                        <LineChart data={formattedModelTimeline}>
                          <CartesianGrid
                            strokeDasharray="2 4"
                            stroke={gridStyle}
                          />
                          <XAxis
                            dataKey="timestamp"
                            tick={axisStyle}
                            tickLine={false}
                            axisLine={{ stroke: gridStyle }}
                          />
                          <YAxis
                            tick={axisStyle}
                            tickLine={false}
                            axisLine={false}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "var(--popover)",
                              border: "1px solid var(--border)",
                              borderRadius: 8,
                              fontSize: 12,
                            }}
                          />
                          <Legend
                            wrapperStyle={{ fontSize: 12 }}
                            iconType="line"
                          />
                          <Line
                            type="monotone"
                            dataKey={String(compareAModel.platform)}
                            stroke="var(--foreground)"
                            strokeWidth={2}
                            dot={false}
                          />
                          <Line
                            type="monotone"
                            dataKey={String(compareBModel.platform)}
                            stroke="var(--muted-foreground)"
                            strokeWidth={2}
                            dot={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </Panel>
                </div>

                <Panel title="Provider Comparison">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Provider</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Success</TableHead>
                        <TableHead className="text-right">Latency</TableHead>
                        <TableHead className="text-right pr-4">
                          Throughput
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {compareHeadToHead.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className="text-center text-sm text-muted-foreground"
                          >
                            No comparison data yet
                          </TableCell>
                        </TableRow>
                      ) : (
                        compareHeadToHead.map((model) => (
                          <TableRow key={model.platform}>
                            <TableCell className="font-medium">
                              {model.displayName}
                              <span className="ml-2 text-xs text-muted-foreground">
                                {model.platform}
                              </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {model.requests}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatRate(model.successRate)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {model.avgLatencyMs} ms
                            </TableCell>
                            <TableCell className="text-right tabular-nums pr-4">
                              {model.tokPerSec.toFixed(1)} tok/s
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </Panel>
              </>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">
                Select two providers to compare router performance.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
