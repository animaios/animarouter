import { useState } from 'react'
import { Activity } from 'lucide-react'
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  type ModelHealthInput,
  toRadarAxes,
} from '@/lib/health-radar'

interface ModelHealthPopoverProps {
  label: string
  health: ModelHealthInput | undefined
  totalRequests?: number
}

const AXIS_COLOR = '#8b8b8b'
const GRID_COLOR = 'rgba(140, 140, 140, 0.18)'

interface TooltipProps {
  active?: boolean
  payload?: Array<{ payload: { axis: string; value: number } }>
}

function RadarTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null
  const { axis, value } = payload[0].payload
  return (
    <div className="rounded-lg border border-white/10 bg-black/90 px-2.5 py-1.5 text-xs">
      <span className="text-muted-foreground">{axis}:</span>{' '}
      <span className="font-mono text-orange-500">
        {Math.round(value * 100)}
      </span>
    </div>
  )
}

export function ModelHealthPopover({
  label,
  health,
  totalRequests,
}: ModelHealthPopoverProps) {
  const [open, setOpen] = useState(false)
  const data = toRadarAxes(health)
  const hasData = health !== undefined && (totalRequests ?? 0) > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="ml-1 inline-flex items-center justify-center rounded-md p-0.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-orange-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange-500/40"
        aria-label={`Health profile for ${label}`}
      >
        <Activity className="size-3" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        sideOffset={6}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="w-[260px] !rounded-2xl !border-white/10 !bg-[#0d0d0d] !p-3"
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">
            {label}
          </span>
          <span className="text-[10px] text-muted-foreground/60 tabular-nums">
            {hasData
              ? `${totalRequests} obs`
              : 'no data · priors'}
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
                cursor={{ stroke: '#ff6a00', strokeOpacity: 0.3, strokeDasharray: '3 3' }}
                content={<RadarTooltip />}
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
      </PopoverContent>
    </Popover>
  )
}
