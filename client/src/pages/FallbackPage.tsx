import { useMemo, useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { SlidersHorizontal, Pencil } from 'lucide-react'
import { apiFetch } from '@/lib/api'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { ModelsTabs } from '@/components/models-tabs'
import { Tooltip } from '@/components/tooltip'
import { ModelSearchBox, matchesModelQuery } from '@/components/model-search-box'

interface FallbackEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  penalty: number
  rateLimitHits: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  tpmLimit: number | null
  tpdLimit: number | null
  contextWindow: number | null
  maxOutputTokens: number | null
  supportsVision: boolean
  supportsTools: boolean
  keyCount: number
  // Real performance metrics
  actualTokPerSec?: number
  actualAvgTtfbMs?: number | null
  totalRequests?: number
  successRate?: number
}

type RoutingStrategy = 'priority' | 'balanced' | 'smartest' | 'fastest' | 'reliable' | 'custom'

type RoutingWeights = { reliability: number; speed: number; intelligence: number }

interface RoutingScore {
  modelDbId: number
  reliability: number
  speed: number
  intelligence: number
  rateLimit: number
  score: number
  totalRequests: number
}

interface RoutingData {
  strategy: RoutingStrategy
  weights: RoutingWeights | null
  customWeights: RoutingWeights
  scores: (RoutingScore & { platform: string; modelId: string; displayName: string; enabled: boolean })[]
}

// A merged row: fallback-chain metadata + live bandit scores.
type Row = FallbackEntry & Partial<RoutingScore>

const STRATEGIES: { key: RoutingStrategy; label: string; blurb: string }[] = [
  { key: 'priority', label: 'Manual', blurb: 'Route in the exact order you set below. Drag the handles to reorder. No scoring; the chain is followed top-to-bottom.' },
  { key: 'balanced', label: 'Balanced', blurb: 'Reliability leads (50%), with speed and intelligence weighted equally (25% each). A sensible all-round default.' },
  { key: 'smartest', label: 'Smartest', blurb: 'Prefer the most capable model that still works. Intelligence 55%, reliability 35%, speed 10%.' },
  { key: 'fastest', label: 'Fastest', blurb: 'Prefer the fastest model that still works. Speed 55%, reliability 35%, intelligence 10%.' },
  { key: 'reliable', label: 'Most reliable', blurb: 'Maximize success rate above all. Reliability 70%, speed and intelligence 15% each.' },
  { key: 'custom', label: 'Custom', blurb: 'Set your own balance of reliability, speed and intelligence with sliders. Same engine as the presets, just your weights.' },
]

// Slider axes share the colors used by the score table columns below.
const WEIGHT_AXES: { key: keyof RoutingWeights; label: string; color: string }[] = [
  { key: 'reliability', label: 'Reliability', color: '#22c55e' },
  { key: 'speed', label: 'Speed', color: '#3b82f6' },
  { key: 'intelligence', label: 'Intelligence', color: '#a855f7' },
]

// Slider popover for the 'custom' strategy. Sliders are independent (0-100)
// and the server renormalizes any vector, so we just show each axis's
// effective share live. Nothing is saved until Apply is pressed.
function CustomWeightsPopover({ saved, onSave, saving }: {
  saved: RoutingWeights
  onSave: (w: RoutingWeights) => void
  saving: boolean
}) {
  const [values, setValues] = useState<RoutingWeights>(() => fromSaved(saved))
  const [dirty, setDirty] = useState(false)

  function fromSaved(w: RoutingWeights): RoutingWeights {
    return {
      reliability: Math.round(w.reliability * 100),
      speed: Math.round(w.speed * 100),
      intelligence: Math.round(w.intelligence * 100),
    }
  }

  function update(key: keyof RoutingWeights, v: number) {
    setValues({ ...values, [key]: v })
    setDirty(true)
  }

  function apply() {
    if (sum <= 0) return
    onSave({
      reliability: values.reliability / 100,
      speed: values.speed / 100,
      intelligence: values.intelligence / 100,
    })
    setDirty(false)
  }

  const sum = values.reliability + values.speed + values.intelligence

  return (
    <Popover onOpenChange={open => { if (open) { setValues(fromSaved(saved)); setDirty(false) } }}>
      <PopoverTrigger className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
        <SlidersHorizontal className="size-3.5" />
        Adjust
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">Custom weights</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Sliders are independent; shares auto-balance to 100%.
            </p>
          </div>
          {WEIGHT_AXES.map(axis => {
            const share = sum > 0 ? Math.round((values[axis.key] / sum) * 100) : 0
            return (
              <div key={axis.key}>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-sm" style={{ background: axis.color }} />
                    {axis.label}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{share}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={values[axis.key]}
                  onChange={e => update(axis.key, Number(e.target.value))}
                  className="w-full cursor-pointer"
                  style={{ accentColor: axis.color }}
                  aria-label={`${axis.label} weight`}
                />
              </div>
            )
          })}
          {sum <= 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              At least one weight must be above zero.
            </p>
          )}
          <Button
            size="sm"
            className="w-full"
            disabled={!dirty || sum <= 0 || saving}
            onClick={apply}
          >
            {saving ? 'Applying…' : dirty ? 'Apply' : 'Applied'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// A 0..1 value as a thin horizontal bar. Number appears on hover via group wrapper.
function AxisBar({ value, color }: { value: number | undefined; color: string }) {
  const v = value ?? 0
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.round(v * 100)}%`, backgroundColor: color }} />
      </div>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums w-7 text-right opacity-0 group-hover:opacity-100 transition-opacity">
        {value === undefined ? '–' : Math.round(v * 100)}
      </span>
    </div>
  )
}

// ── One row of the unified table ────────────────────────────────────────────
function EditModelModal({
  model,
  onClose,
  onQueueEdit,
}: {
  model: Row
  onClose: () => void
  onQueueEdit: (modelDbId: number, body: Record<string, unknown>) => void
}) {
  const [displayName, setDisplayName] = useState(model.displayName)
  const [contextWindow, setContextWindow] = useState(model.contextWindow ?? 128000)
  const [maxOutputTokens, setMaxOutputTokens] = useState(model.maxOutputTokens ?? null as number | null)
  const [intelligenceRank, setIntelligenceRank] = useState(model.intelligenceRank)
  const [speedRank, setSpeedRank] = useState(model.speedRank)
  const [sizeLabel, setSizeLabel] = useState(model.sizeLabel)
  const [supportsTools, setSupportsTools] = useState(model.supportsTools)
  const [supportsVision, setSupportsVision] = useState(model.supportsVision)
  const [rpmLimit, setRpmLimit] = useState(model.rpmLimit ?? null)
  const [rpdLimit, setRpdLimit] = useState(model.rpdLimit ?? null)
  const [tpmLimit, setTpmLimit] = useState(model.tpmLimit ?? null)
  const [tpdLimit, setTpdLimit] = useState(model.tpdLimit ?? null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const body: Record<string, unknown> = {
      displayName: displayName.trim(),
      contextWindow: contextWindow || null,
      maxOutputTokens: maxOutputTokens,
      intelligenceRank,
      speedRank,
      sizeLabel,
      supportsTools,
      supportsVision,
      rpmLimit,
      rpdLimit,
      tpmLimit,
      tpdLimit,
    }
    onQueueEdit(model.modelDbId, body)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-3xl border bg-card p-5 shadow-lg max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-medium">Edit model</h3>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">{model.platform}/{model.modelId}</p>
          </div>
          <Button variant="ghost" size="xs" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </Button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Display name</Label>
            <Input value={displayName} onChange={e => setDisplayName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Context window</Label>
              <Input type="number" min={0} value={contextWindow} onChange={e => setContextWindow(parseInt(e.target.value, 10) || 0)} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Max output tokens</Label>
              <Input type="number" min={0} value={maxOutputTokens ?? ''} onChange={e => { const v = parseInt(e.target.value, 10); setMaxOutputTokens(v > 0 ? v : null) }} placeholder="no limit" className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Intelligence rank</Label>
              <Input type="number" min={1} max={100} value={intelligenceRank} onChange={e => setIntelligenceRank(parseInt(e.target.value, 10) || 50)} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Speed rank</Label>
              <Input type="number" min={1} max={100} value={speedRank} onChange={e => setSpeedRank(parseInt(e.target.value, 10) || 50)} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Size label</Label>
              <Input value={sizeLabel} onChange={e => setSizeLabel(e.target.value)} className="font-mono text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-6 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <Switch checked={supportsTools} onCheckedChange={setSupportsTools} />
              Supports tools
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <Switch checked={supportsVision} onCheckedChange={setSupportsVision} />
              Supports vision
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">RPM limit</Label>
              <Input type="number" min={0} value={rpmLimit ?? ''} onChange={e => setRpmLimit(e.target.value ? parseInt(e.target.value, 10) : null)} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">RPD limit</Label>
              <Input type="number" min={0} value={rpdLimit ?? ''} onChange={e => setRpdLimit(e.target.value ? parseInt(e.target.value, 10) : null)} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">TPM limit</Label>
              <Input type="number" min={0} value={tpmLimit ?? ''} onChange={e => setTpmLimit(e.target.value ? parseInt(e.target.value, 10) : null)} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">TPD limit</Label>
              <Input type="number" min={0} value={tpdLimit ?? ''} onChange={e => setTpdLimit(e.target.value ? parseInt(e.target.value, 10) : null)} className="font-mono text-xs" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm">Queue edit</Button>
          </div>
        </form>
      </div>
    </div>
  )
}

function RowContent({
  row,
  rank,
  draggable,
  dragHandle,
  onToggle,
  onEdit,
}: {
  row: Row
  rank: number
  draggable: boolean
  dragHandle?: ReactNode
  onToggle: (modelDbId: number, enabled: boolean) => void
  onEdit: (row: Row) => void
}) {
  const guard = row.rateLimit ?? 1
  return (
    <>
      <td className="py-2 pl-3 pr-1 w-6 align-middle">
        {draggable ? dragHandle : <span className="text-muted-foreground/30 select-none">·</span>}
      </td>
      <td className="py-2 pr-2 w-6 text-center font-mono text-xs text-muted-foreground tabular-nums align-middle">{rank}</td>
      <td className="py-2 pr-3 align-middle">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{row.displayName}</span>
          <span className="text-xs text-muted-foreground">{row.platform}</span>
          {row.supportsVision && (
            <span
              title="Accepts image input"
              className="text-[10px] rounded-full px-1.5 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400"
            >
              Vision
            </span>
          )}
          {row.supportsTools && (
            <span
              title="Emits structured tool calls, so it is eligible for tool-bearing requests"
              className="text-[10px] rounded-full px-1.5 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400"
            >
              Tools
            </span>
          )}
          {(row.penalty ?? 0) > 0 && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">−{Math.round(row.penalty)} penalty</span>
          )}
          {row.totalRequests !== undefined && row.totalRequests > 0 && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums">{row.totalRequests} obs</span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground/70 tabular-nums mt-0.5">
          {row.rpmLimit ? `${row.rpmLimit} rpm` : ''}
          {row.rpmLimit && row.rpdLimit ? ' · ' : ''}
          {row.rpdLimit ? `${row.rpdLimit} rpd` : ''}
          {!row.rpmLimit && !row.rpdLimit ? '—' : ''}
        </div>
      </td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={row.reliability} color="#22c55e" /></td>
      <td className="py-2 pr-3 align-middle">
        <div className="flex flex-col gap-1">
          <div className="text-xs font-mono text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
            {row.actualTokPerSec !== undefined && row.actualTokPerSec > 0
              ? `${Math.round(row.actualTokPerSec)} tok/s real`
              : row.totalRequests !== undefined && row.totalRequests > 0
                ? `${(row.successRate ?? 0).toFixed(0)}% success`
                : 'No data'
            }
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.round((row.speed ?? 0) * 100)}%`, backgroundColor: '#3b82f6' }} />
            </div>
            <div className="flex items-center gap-1">
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums w-7 text-right opacity-0 group-hover:opacity-100 transition-opacity">
                {Math.round((row.speed ?? 0) * 100)}
              </span>
              {row.actualAvgTtfbMs && (
                <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">{row.actualAvgTtfbMs >= 1000 ? `${(row.actualAvgTtfbMs / 1000).toFixed(2)}s` : `${Math.round(row.actualAvgTtfbMs)}ms`} ttfb</span>
              )}
            </div>
          </div>
        </div>
      </td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={row.intelligence} color="#a855f7" /></td>
      <td className="py-2 pr-3 align-middle font-mono text-[11px] text-muted-foreground tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">
        {guard < 0.999 ? `×${Math.round(guard * 100) / 100}` : '—'}
      </td>
      <td className="py-2 pr-3 align-middle text-right font-mono text-xs font-medium tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">
        {row.score !== undefined ? Math.round(row.score) : '–'}
      </td>
      <td className="py-2 pr-3 align-middle text-right">
        <div className="flex items-center gap-1 justify-end">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(row); }}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Edit model"
          >
            <Pencil className="size-3.5" />
          </button>
          <Switch checked={row.enabled} onCheckedChange={(c) => onToggle(row.modelDbId, c)} />
        </div>
      </td>
    </>
  )
}

function SortableRow({ row, rank, onToggle, onEdit }: { row: Row; rank: number; onToggle: (id: number, e: boolean) => void; onEdit: (row: Row) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.modelDbId })
  const handle = (
    <button
      {...attributes}
      {...listeners}
      className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors"
      aria-label="Drag to reorder"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
        <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
        <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
      </svg>
    </button>
  )
  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`border-b last:border-0 bg-card group ${isDragging ? 'opacity-50' : ''} ${row.enabled ? '' : 'opacity-50'}`}
    >
      <RowContent row={row} rank={rank} draggable dragHandle={handle} onToggle={onToggle} onEdit={onEdit} />
    </tr>
  )
}

export default function FallbackPage() {
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)
  const [editingModel, setEditingModel] = useState<Row | null>(null)
  const [pendingModelEdits, setPendingModelEdits] = useState<Map<number, Record<string, unknown>>>(new Map())

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: performanceData = [] } = useQuery<Array<{
    modelDbId: number
    platform: string
    modelId: string
    displayName: string
    actualTokPerSec: number
    actualAvgTtfbMs: number | null
    totalRequests: number
    successRate: number
  }>>({
    queryKey: ['fallback', 'performance'],
    queryFn: () => apiFetch('/api/fallback/performance'),
  })

  const { data: routing } = useQuery<RoutingData>({
    queryKey: ['fallback', 'routing'],
    queryFn: () => apiFetch('/api/fallback/routing'),
    refetchInterval: 15_000,
  })

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setLocalEntries(null)
    },
  })

  const strategyMutation = useMutation({
    mutationFn: (payload: { strategy: RoutingStrategy; weights?: RoutingWeights }) =>
      apiFetch('/api/fallback/routing', { method: 'PUT', body: JSON.stringify(payload) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] }),
  })

  const strategy: RoutingStrategy = routing?.strategy ?? 'balanced'
  const isManual = strategy === 'priority'

  const allEntries = localEntries ?? entries
  // Merge fallback metadata with live scores, keyed by model.
  const scoreById = new Map((routing?.scores ?? []).map(s => [s.modelDbId, s]))
  const configured = allEntries.filter(e => e.keyCount > 0)
  const unconfiguredPlatforms = [...new Set(allEntries.filter(e => e.keyCount === 0).map(e => e.platform))]

  // Live search filter on the configured rows. Cheap (~750 entries,
  // <100-char string compares), so no debounce — runs on every keystroke.
  const [query, setQuery] = useState('')
  const [sortByRealSpeed, setSortByRealSpeed] = useState(false)
  const filteredConfigured = useMemo(
    () => configured.filter(e =>
      matchesModelQuery(query, { displayName: e.displayName, modelId: e.modelId, platform: e.platform }),
    ),
    [configured, query],
  )

  // Merge performance data with entries
  const entriesWithPerformance = useMemo(() => {
    const performanceMap = new Map(performanceData.map(p => [p.modelDbId, p]));
    return entries.map(entry => ({
      ...entry,
      ...performanceMap.get(entry.modelDbId)
    }));
  }, [entries, performanceData])

  // Entry fields win on overlap: the routing snapshot also carries `enabled`
  // (and identity fields), which would otherwise clobber unsaved local toggles.
  const rows: Row[] = filteredConfigured.map(e => ({
    ...(scoreById.get(e.modelDbId) ?? {}),
    ...entriesWithPerformance.find(p => p.modelDbId === e.modelDbId),
    ...e
  }))
  // The unfiltered set is what drag-reorder operates on. If we let drag
  // fire on a filtered slice, `setLocalEntries` would persist that *slice*
  // and silently drop the rows the user hadn't seen. So when a query is
  // active, drag is disabled at the row level (see `draggable` prop) and
  // `ordered` falls back to the unfiltered list.
  // Manual → the order you set (by priority). Bandit → ranked by live score.
  // Real speed → sorted by actual token/sec from collected data
  const ordered = isManual
    ? [...rows].sort((a, b) => a.priority - b.priority)
    : sortByRealSpeed
      ? [...rows].sort((a, b) => (b.actualTokPerSec ?? 0) - (a.actualTokPerSec ?? 0))
      : [...rows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )


  function handleDragEnd(event: DragEndEvent) {
    // Auto-scroll is handled by dnd-kit's built-in useAutoScroller, which
    // monitors the dragged item's rect against the scroll container's rect
    // and ramps a setInterval-based scroll. dnd-kit cleans up its own
    // interval on drag end.
    const { active, over } = event
    if (!over || active.id === over.id) return
    // SortableContext only ever sees the filtered `ordered` rows; drag-end
    // re-emits a merged fallback list with the SAME permutation the user
    // acted on, but applied to the unfiltered configured rows. Anything
    // currently hidden by the search keeps its current priority, so the
    // hidden block doesn't get reshuffled by a UI-level reorder.
    const oldIndex = ordered.findIndex(e => e.modelDbId === active.id)
    const newIndex = ordered.findIndex(e => e.modelDbId === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const reorderedVisible = arrayMove(ordered, oldIndex, newIndex)
    const unconfigured = allEntries.filter(e => e.keyCount === 0)
    const merged: FallbackEntry[] = [
      ...reorderedVisible.map((e, i) => ({ ...(e as FallbackEntry), priority: i + 1 })),
      ...unconfigured.map((e, i) => ({ ...e, priority: reorderedVisible.length + i + 1 })),
    ]
    setLocalEntries(merged)
  }

  function handleToggle(modelDbId: number, enabled: boolean) {
    setLocalEntries(allEntries.map(e => (e.modelDbId === modelDbId ? { ...e, enabled } : e)))
  }

  function handleToggleAll(enabled: boolean) {
    setLocalEntries(allEntries.map(e => (e.keyCount > 0 ? { ...e, enabled } : e)))
  }

  const hasChanges = localEntries !== null || pendingModelEdits.size > 0

  async function handleSaveAll() {
    // Snapshot pending state before any API call so we can roll back on failure.
    const backupModelEdits = new Map(pendingModelEdits)
    const backupLocalEntries = localEntries
    const saved: string[] = []

    try {
      // Save model edits
      if (pendingModelEdits.size > 0) {
        for (const [id, body] of pendingModelEdits) {
          await apiFetch(`/api/custom-models/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
        }
        saved.push(`${pendingModelEdits.size} model edit(s)`)
      }
      // Enabled-first rebase: before persisting the user's toggle changes,
      // every enabled model moves to the top, preserving the relative order
      // it had within its own group. This MUST only happen at save time —
      // flipping a switch mid-edit keeps the row exactly where it was so the
      // user can review the change in the floating bar before committing.
      // Drag-reorder local edits are kept as the within-group order; the
      // rebase just collapses the priorities so enabled rows get 1..k and
      // disabled get k+1..N. Stable sort by current priority gives us
      // "after all the already enabled models" semantics: a newly-enabled row
      // keeps the priority slot it had under disabled, and lands at the end
      // of the enabled band after re-numbering.
      if (localEntries !== null) {
        const byId = new Map(localEntries.map(e => [e.modelDbId, e]))
        const ordered = [...localEntries].sort((a, b) => a.priority - b.priority)
        const enabled = ordered.filter(e => e.enabled)
        const disabled = ordered.filter(e => !e.enabled)
        const rebased = [...enabled, ...disabled].map((e, i) => ({ ...e, priority: i + 1 }))
        // Stage the rebased set so a partial failure stages these new
        // priorities instead of leaving the table partitioned on-screen but
        // the server still on old numbers.
        for (const e of rebased) byId.set(e.modelDbId, e)
        setLocalEntries([...byId.values()])
        await saveMutation.mutateAsync(rebased.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled })))
        saved.push('sort order')
      }
      // All API calls succeeded — clear pending state and invalidate caches.
      setPendingModelEdits(new Map())
      setLocalEntries(null)
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    } catch (err) {
      // Partial failure — restore pending state so edits are not silently lost.
      setPendingModelEdits(backupModelEdits)
      setLocalEntries(backupLocalEntries)
      throw err
    }

    return saved
  }

  function handleDiscardAll() {
    setLocalEntries(null)
    setPendingModelEdits(new Map())
  }

  const [savingAll, setSavingAll] = useState(false)

  const tableHead = (
    <thead>
      <tr className="text-left text-muted-foreground border-b">
        <th className="py-2 pl-3 pr-1 w-6"></th>
        <th className="py-2 pr-2 w-6 text-center font-medium">#</th>
        <th className="py-2 pr-3 font-medium">Model</th>
        <th className="py-2 pr-3 font-medium">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: '#22c55e' }} />Reliability</span>
        </th>
        <th className="py-2 pr-3 font-medium">
          <div className="flex items-center gap-1">
            <span className="inline-flex items-center gap-1">
              <span className="size-2 rounded-sm" style={{ background: '#3b82f6' }} />
              <span>Speed</span>
            </span>
            <Button
              variant={sortByRealSpeed ? "default" : "outline"}
              size="sm"
              onClick={() => setSortByRealSpeed(!sortByRealSpeed)}
              className="h-6 text-xs"
              title={sortByRealSpeed ? "Showing actual token/sec (click to show normalized score)" : "Show actual token/sec from collected data"}
            >
              {sortByRealSpeed ? "Real T/s" : "T/s"}
            </Button>
          </div>
        </th>
        <th className="py-2 pr-3 font-medium">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: '#a855f7' }} />Intelligence</span>
        </th>
        <th className="py-2 pr-3 font-medium">
          <Tooltip text="Live rate-limit penalty. Below 1.0 means the model is being demoted due to recent 429s.">
            <span className="underline decoration-dotted underline-offset-2 cursor-help">Guardrails</span>
          </Tooltip>
        </th>
        <th className="py-2 pr-3 font-medium text-right">
          <Tooltip text="Final routing score = weighted average of reliability, speed and intelligence, multiplied by the rate-limit guardrail. Higher routes first.">
            <span className="underline decoration-dotted underline-offset-2 cursor-help">Score</span>
          </Tooltip>
        </th>
        <th className="py-2 pr-3 font-medium text-right">
          <label className="flex items-center gap-1 justify-end cursor-pointer" title="Enable all / disable all">
            <Switch
              checked={configured.every(e => e.enabled)}
              onCheckedChange={(c) => handleToggleAll(c)}
            />
            <span>On</span>
          </label>
        </th>
      </tr>
    </thead>
  )

  return (
    <div>
      <PageHeader
        title="Models"
        description="Pick a routing strategy. In Manual mode you drag to set the order; the other strategies route by live score across reliability, speed and intelligence."
        divider={false}
        actions={<ModelsTabs />}
      />

      <div className="space-y-6">
        {/* Strategy selector */}
        <section className="rounded-3xl border bg-card p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-medium">Routing strategy</h2>
            {routing?.weights && (
              <span className="text-xs text-muted-foreground tabular-nums">
                reliability {Math.round(routing.weights.reliability * 100)}% ·
                {' '}speed {Math.round(routing.weights.speed * 100)}% ·
                {' '}intelligence {Math.round(routing.weights.intelligence * 100)}%
              </span>
            )}
          </div>

          <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border p-1">
            {STRATEGIES.map(s => (
              <Tooltip key={s.key} text={s.blurb}>
                <button
                  disabled={strategyMutation.isPending}
                  onClick={() => strategyMutation.mutate({ strategy: s.key })}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                    s.key === strategy
                      ? 'bg-foreground text-background font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  {s.label}
                </button>
              </Tooltip>
            ))}
            {strategy === 'custom' && routing && (
              <CustomWeightsPopover
                saved={routing.customWeights}
                saving={strategyMutation.isPending}
                onSave={w => strategyMutation.mutate({ strategy: 'custom', weights: w })}
              />
            )}
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            {isManual
              ? 'Manual mode: requests follow the order below, top-to-bottom. Drag to reorder.'
              : 'Scores update from live traffic. The order below is how requests are routed right now.'}
          </p>
        </section>

        {/* Unified routing / fallback table */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : ordered.length === 0 && query === '' ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No models available. Add API keys on the <a href="/keys" className="underline text-foreground">Keys page</a> first.
            </p>
          </div>
        ) : (
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <ModelSearchBox
                value={query}
                onChange={setQuery}
                showCount
                total={configured.length}
                matched={ordered.length}
                placeholder="Filter models by name, id, or platform…"
              />
              {query !== '' && isManual && (
                <p className="text-[11px] text-muted-foreground">
                  Reorder is disabled while searching — clear the filter to drag rows.
                </p>
              )}
            </div>

            {ordered.length === 0 ? (
              <div className="rounded-2xl border border-dashed p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No models match <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono">{query}</code>.
                </p>
              </div>
            ) : (
              <>
                {/* DndContext must wrap OUTSIDE the table: it renders hidden a11y
                    live-region <div>s, which are invalid as direct <table> children. */}
                {isManual && query === '' ? (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                    autoScroll={{
                      // Smooth, decisive edge-scroll. dnd-kit watches the dragged
                      // item's rect against the scroll container's rect and
                      // ramps a setInterval-driven scrollBy. The drag handle
                      // travels with the pointer, so this is equivalent to
                      // "pointer near the edge of the viewport" but uses the
                      // engine's optimised path.
                      // - threshold.y = 12% of viewport height: autoscroll
                      //   only fires when the dragged row is well inside the
                      //   top/bottom edge band (~85 px on a 700-px viewport).
                      //   Lower than the 20% default to avoid scrolling when
                      //   the user is just resting the pointer near the edge.
                      // - acceleration = 30 px per interval at the edge.
                      //   With interval=8, peak scroll speed = 30 / 0.008 s
                      //   = 3750 px/s, smooth on a 60 Hz display because
                      //   each call is small (4..30 px).
                      // - interval = 8 ms ≈ 125 Hz, clamped by the browser
                      //   to 60 Hz on a 60 Hz display. The ramp is what
                      //   reads as "smooth" — dnd-kit computes
                      //   `acceleration * (distance / threshold)` per tick.
                      enabled: true,
                      acceleration: 30,
                      interval: 8,
                      threshold: { x: 0.05, y: 0.12 },
                    }}
                  >
                    <div className="rounded-2xl border overflow-x-auto">
                      <table className="w-full text-sm">
                        {tableHead}
                        <SortableContext items={ordered.map(e => e.modelDbId)} strategy={verticalListSortingStrategy}>
                          <tbody>
                            {ordered.map((row, i) => (
                              <SortableRow key={row.modelDbId} row={row} rank={i + 1} onToggle={handleToggle} onEdit={setEditingModel} />
                            ))}
                          </tbody>
                        </SortableContext>
                      </table>
                    </div>
                  </DndContext>
                ) : (
                  <div className="rounded-2xl border overflow-x-auto">
                    <table className="w-full text-sm">
                      {tableHead}
                      <tbody>
                        {ordered.map((row, i) => (
                          <tr key={row.modelDbId} className={`border-b last:border-0 group ${row.enabled ? '' : 'opacity-50'}`}>
                            <RowContent row={row} rank={i + 1} draggable={false} onToggle={handleToggle} onEdit={setEditingModel} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Floating action bar — fixed to the viewport so it's always visible,
                    sliding up when there are unsaved changes and back down on save/discard. */}
                <FloatingBar show={hasChanges}>
                  <span className="text-xs text-muted-foreground">Unsaved changes</span>
                  <Button variant="outline" size="sm" onClick={handleDiscardAll}>Discard</Button>
                  <Button size="sm" onClick={() => { setSavingAll(true); handleSaveAll().finally(() => setSavingAll(false)) }} disabled={savingAll}>
                    {savingAll ? 'Saving…' : 'Save changes'}
                  </Button>
                </FloatingBar>

                {unconfiguredPlatforms.length > 0 && (
                  <p className="text-xs text-muted-foreground">Hidden (no keys): {unconfiguredPlatforms.join(', ')}</p>
                )}
              </>
            )}
          </section>
        )}
        {editingModel && (
          <EditModelModal
            model={editingModel}
            onClose={() => setEditingModel(null)}
            onQueueEdit={(id, body) => setPendingModelEdits(prev => { const next = new Map(prev); next.set(id, body); return next })}
          />
        )}
      </div>
    </div>
  )
}
