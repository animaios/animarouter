import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { ChartPanel } from "./RouterStatsPage";
import type {
  HourWindow,
  PingHourlyStat,
  RebucketedHourlyStat,
} from "./router-stats-data";

interface HourlyDatum {
  hour: number;
  hourLabel: string;
  requests: number;
  latencyS: number;
  pingLatencyS: number | null;
  pingOverlay: number | null;
  errorRate: number;
  score: number;
  grade: "HIGH" | "OK" | "LOW" | "NONE";
}

const gradeFill = (grade: HourlyDatum["grade"]) => {
  if (grade === "HIGH") return "var(--router-stat-green)";
  if (grade === "OK") return "var(--router-stat-yellow)";
  if (grade === "LOW") return "var(--router-stat-red)";
  return "var(--router-stat-cyan)";
};

interface ProductivityTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: HourlyDatum }>;
}

function ProductivityTooltip({ active, payload }: ProductivityTooltipProps) {
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;

  const pingNote =
    datum.pingOverlay !== null
      ? `${datum.pingOverlay.toFixed(1)}s baseline (${datum.requests > 0 ? "" : " ping-only"})`
      : undefined;

  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="font-medium">{datum.hourLabel}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">Latency</dt>
        <dd className="text-right">{datum.latencyS.toFixed(1)}s avg</dd>
        <dt className="text-muted-foreground">Requests</dt>
        <dd className="text-right">{datum.requests}</dd>
        <dt className="text-muted-foreground">Errors</dt>
        <dd className="text-right">{datum.errorRate}%</dd>
        {pingNote && (
          <>
            <dt className="text-muted-foreground">Ping baseline</dt>
            <dd className="text-right">{pingNote}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function WindowPill({ window: w }: { window: HourWindow }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs",
        w.grade === "HIGH"
          ? "border-[color:oklch(0.62_0.2_151_/_0.45)] bg-[color:oklch(0.62_0.2_151_/_0.12)]"
          : w.grade === "OK"
            ? "border-yellow-500/40 bg-yellow-500/10"
            : "border-rose-500/40 bg-rose-500/10",
      )}
    >
      <span className="font-medium tracking-wide">{w.label}</span>
      <span className="tabular-nums text-muted-foreground">
        {w.score} {w.grade}
      </span>
    </div>
  );
}

interface HourlyProductivityChartProps {
  rows: RebucketedHourlyStat[];
  windows: HourWindow[];
  scoreByHour: Map<number, number>;
  pingRows: PingHourlyStat[];
}

export function HourlyProductivityChart({
  rows,
  windows,
  scoreByHour,
  pingRows,
}: HourlyProductivityChartProps) {
  const pingByHour = useMemo(() => {
    const map = new Map<number, PingHourlyStat>();
    for (const p of pingRows) map.set(p.hour, p);
    return map;
  }, [pingRows]);

  const maxPingLatencyS = useMemo(() => {
    const values = pingRows.map((p) => p.avgLatencyMs).filter((v) => v > 0);
    return values.length > 0 ? Math.max(...values) / 1000 : 0;
  }, [pingRows]);

  const data = useMemo<HourlyDatum[]>(
    () =>
      rows.map((r) => {
        const score = scoreByHour.get(r.hour) ?? 0;
        const ping = pingByHour.get(r.hour);
        const pingOverlay =
          ping && ping.avgLatencyMs > 0
            ? Number((ping.avgLatencyMs / 1000).toFixed(2))
            : null;
        return {
          hour: r.hour,
          hourLabel: `${String(r.hour).padStart(2, "0")}:00`,
          requests: r.requests,
          latencyS: Number((r.avgLatencyMs / 1000).toFixed(2)),
          // When no ping data for this hour, leave the overlay null so
          // Recharts omits the segment rather than drawing a misleading 0s.
          pingLatencyS:
            ping && ping.avgLatencyMs > 0 ? ping.avgLatencyMs / 1000 : null,
          pingOverlay,
          errorRate: r.errorRate,
          score,
          grade:
            score >= 75
              ? "HIGH"
              : score >= 55
                ? "OK"
                : score > 0
                  ? "LOW"
                  : "NONE",
        } satisfies HourlyDatum;
      }),
    [rows, scoreByHour, pingByHour],
  );

  const hasData =
    rows.some((r) => r.requests > 0) || pingRows.some((p) => p.requests > 0);
  const maxLatency = Math.max(
    1,
    ...data.map((d) => d.latencyS),
    maxPingLatencyS,
  );

  return (
    <ChartPanel
      title="Best timeslot to work"
      className="lg:col-span-2"
      actions={
        <span className="text-[11px] text-muted-foreground">
          Low latency + high throughput
        </span>
      }
    >
      {!hasData ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No routed requests or pings in this window — productivity scoring
          needs data.
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart
              data={data}
              margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="2 4"
                stroke="var(--router-stat-grid)"
              />
              <XAxis
                dataKey="hourLabel"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={{ stroke: "var(--router-stat-grid)" }}
                interval={1}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v: number) => `${v.toFixed(0)}s`}
                domain={[0, Math.ceil(maxLatency)]}
              />
              <Tooltip content={<ProductivityTooltip />} />
              <Bar
                dataKey="latencyS"
                name="Real latency (s)"
                radius={[3, 3, 0, 0]}
              >
                {data.map((d) => (
                  <Cell key={d.hour} fill={gradeFill(d.grade)} />
                ))}
              </Bar>
              <Line
                type="monotone"
                dataKey="pingLatencyS"
                name="Ping baseline (s)"
                stroke="var(--router-stat-cyan)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                activeDot={false}
                connectNulls={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="mt-4 flex flex-wrap gap-2">
            {windows.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                Need more traffic or pings to identify productive windows.
              </span>
            ) : (
              windows.map((w) => <WindowPill key={w.label} window={w} />)
            )}
          </div>
        </>
      )}
    </ChartPanel>
  );
}
