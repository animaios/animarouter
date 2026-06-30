import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Activity } from "lucide-react";
import { type ModelHealthInput, toRadarAxes } from "@/lib/health-radar";

interface ModelHealthPopoverProps {
  label: string;
  health: ModelHealthInput | undefined;
  totalRequests?: number;
}

const AXIS_COLOR = "#8b8b8b";
const GRID_COLOR = "rgba(140, 140, 140, 0.18)";

function RadarTooltipContent({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { axis: string; value: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const { axis, value } = payload[0].payload;
  return (
    <div className="rounded-lg border border-white/10 bg-black/90 px-2.5 py-1.5 text-xs">
      <span className="text-muted-foreground">{axis}:</span>{" "}
      <span className="font-mono text-orange-500">
        {Math.round(value * 100)}
      </span>
    </div>
  );
}


export function ModelHealthPopover({
  label,
  health,
  totalRequests,
}: ModelHealthPopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const data = toRadarAxes(health);
  const hasData = health !== undefined && (totalRequests ?? 0) > 0;

  function open_() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left + r.width / 2, y: r.top - 6 });
    setOpen(true);
  }

  function close_() {
    setOpen(false);
  }

  return (
    <span role="presentation" className="relative inline-flex">
      <button
        ref={btnRef}
        type="button"
        aria-label={`Health profile for ${label}`}
        className="inline-flex cursor-default items-center gap-[3px] rounded-full border border-muted-foreground/15 bg-muted/30 px-1.5 py-[3px] outline-none transition-colors hover:border-orange-500/40 hover:bg-muted/60 focus-visible:ring-1 focus-visible:ring-orange-500/50"
        onMouseEnter={open_}
        onMouseLeave={close_}
        onFocus={open_}
        onBlur={close_}
      >
        <Activity aria-hidden className="size-3" />
      </button>
      {open &&
        createPortal(
          <div
            ref={(el) => {
              if (!el) return;
              el.style.left = `${pos.x}px`;
              el.style.bottom = `${window.innerHeight - pos.y}px`;
              el.style.transform = "translate(-50%, 0)";
            }}
            role="tooltip"
            className="pointer-events-none fixed z-[200] w-[260px] rounded-2xl border border-white/10 bg-[#0d0d0d] p-3 shadow-lg shadow-black/40"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">
                {label}
              </span>
              <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                {hasData ? `${totalRequests} obs` : "no data · priors"}
              </span>
            </div>
            <div className="mt-2 h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart
                  data={data}
                  outerRadius="72%"
                  margin={{ top: 8, right: 18, bottom: 8, left: 18 }}
                >
                  <PolarGrid stroke={GRID_COLOR} strokeWidth={1} />
                  <PolarAngleAxis
                    dataKey="axis"
                    tick={{ fill: AXIS_COLOR, fontSize: 9 }}
                    tickLine={false}
                  />
                  <PolarRadiusAxis
                    angle={90}
                    domain={[0, 1]}
                    tick={false}
                    axisLine={false}
                    tickCount={4}
                  />
                  <Radar
                    dataKey="value"
                    stroke="#ff6a00"
                    fill="#ff6a00"
                    fillOpacity={0.22}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Tooltip
                    cursor={{
                      stroke: "#ff6a00",
                      strokeOpacity: 0.3,
                      strokeDasharray: "3 3",
                    }}
                    content={<RadarTooltipContent />}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-1.5 grid grid-cols-5 gap-1">
              {data.map((d) => (
                <div key={d.axis} className="text-center">
                  <div
                    className="mx-auto mb-0.5 h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: d.color }}
                  />
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
                    {Math.round(d.value * 100)}
                  </span>
                </div>
              ))}
            </div>
            <div className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r border-white/10 bg-[#0d0d0d]" />
          </div>,
          document.body,
        )}
    </span>
  );
}
