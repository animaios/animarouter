export interface ModelHealthInput {
  reliability?: number
  speed?: number
  intelligence?: number
  latency?: number
  successRate?: number
}

export interface RadarAxis {
  axis: string
  value: number
  color: string
}

export const RADAR_AXES: {
  key: keyof ModelHealthInput
  label: string
  color: string
}[] = [
  { key: 'reliability', label: 'Reliability', color: '#22c55e' },
  { key: 'speed', label: 'Speed', color: '#3b82f6' },
  { key: 'intelligence', label: 'Intelligence', color: '#a855f7' },
  { key: 'latency', label: 'Latency', color: '#f59e0b' },
  { key: 'successRate', label: 'Success Rate', color: '#ff6a00' },
]

export const PRIOR_DEFAULTS: ModelHealthInput = {
  reliability: 0.5,
  speed: 0.6,
  intelligence: 0.5,
  latency: 0.6,
  successRate: 100,
}

export function toRadarAxes(
  input: ModelHealthInput | undefined,
): RadarAxis[] {
  const src = input ?? PRIOR_DEFAULTS
  return RADAR_AXES.map(({ key, label, color }) => {
    const raw = src[key] ?? PRIOR_DEFAULTS[key] ?? 0
    const value = key === 'successRate' ? raw / 100 : raw
    return {
      axis: label,
      value: Math.max(0, Math.min(1, value)),
      color,
    }
  })
}
