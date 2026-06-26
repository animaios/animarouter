import { useState, useMemo } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Loader2, AlertTriangle } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { SettingsSection } from '@/components/settings-section'
import { Button } from '@/components/ui/button'
import { addToast } from '@/lib/toast'
import {
  fetchFeatureSettings,
  saveFeatureSettings,
  type FeatureSetting,
} from '@/lib/api'

const GROUP_ORDER = [
  'Retry & Failover',
  'Rate Limiting',
  'Sessions',
  'Resilience',
  'Scoring',
  'Analytics & Data',
  'Degradation',
] as const

const SETTING_ORDER: Record<string, readonly string[]> = {
  Scoring: [
    'routing_reliability_threshold_pct',
    'routing_fastness_threshold_pct',
    'routing_intelligence_threshold_pct',
    'scoring_window_days',
    'scoring_decay_half_life_days',
    'scoring_cache_ttl_sec',
  ],
  'Retry & Failover': [
    'global_retry_limit',
    'transient_cooldown_sec',
    'payment_cooldown_hours',
    'forbidden_cooldown_hours',
  ],
  'Rate Limiting': ['proxy_rate_limit_rpm'],
  Sessions: [
    'key_affinity_enabled',
    'sticky_session_enabled',
    'sticky_session_ttl_min',
    'context_handoff_mode',
    'session_ttl_min',
  ],
  Resilience: [
    'provider_fastfail_enabled',
    'provider_fastfail_threshold',
    'heartbeat_enabled',
    'heartbeat_interval_min',
    'heartbeat_timeout_ms',
    'heartbeat_concurrency',
    'heartbeat_exhausted_recheck_sec',
    'heartbeat_exhausted_max_rechecks',
    'heartbeat_activity_window_min',
    'heartbeat_stagger_ms',
  ],
  'Analytics & Data': ['analytics_retention_days', 'analytics_max_rows'],
  Degradation: [
    'degrade_success_recovery',
    'degrade_max_penalty',
    'degrade_critical_threshold',
    'degrade_minor_half_life_min',
    'degrade_major_half_life_min',
    'degrade_critical_half_life_min',
    'degrade_minor_weight',
    'degrade_major_weight',
    'degrade_critical_weight',
    'degrade_compound_factor',
    'degrade_damp_strength',
    'degrade_boost_min',
    'degrade_boost_max',
  ],
}

const GROUP_RANK = new Map(GROUP_ORDER.map((group, index) => [group, index]))

function rankSetting(group: string, key: string): number {
  const order = SETTING_ORDER[group]
  const index = order?.indexOf(key) ?? -1
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

export default function SettingsPage() {
  const { data, refetch, isLoading, error } = useQuery({
    queryKey: ['settings', 'features'],
    queryFn: fetchFeatureSettings,
  })

  const saveMutation = useMutation({
    mutationFn: saveFeatureSettings,
    onSuccess: () => {
      refetch()
      setLocalValues({})
      addToast({ kind: 'success', title: 'Settings saved' })
    },
    onError: (err: Error) => {
      addToast({ kind: 'warning', title: 'Save failed', description: err.message })
    },
  })

  const [localValues, setLocalValues] = useState<Record<string, boolean | number | string>>({})

  // Compute which keys have actually changed vs server values
  const changedKeys = useMemo(() => {
    if (!data?.settings) return []
    return Object.keys(localValues).filter((k) => {
      const server = data.settings.find((s) => s.key === k)
      return server && localValues[k] !== server.value
    })
  }, [localValues, data])

  const hasChanges = changedKeys.length > 0

  // Whether any changed setting is a restart-effect one
  const hasRestartChanges = useMemo(() => {
    if (!data?.settings) return false
    return changedKeys.some((k) => {
      const s = data.settings.find((s) => s.key === k)
      return s?.effect === 'restart'
    })
  }, [changedKeys, data])

  // Group settings by `group` field, ordered from common controls to advanced tuning.
  const groups = useMemo(() => {
    if (!data?.settings) return []
    const grouped = data.settings.reduce(
      (acc, s) => {
        (acc[s.group] ??= []).push(s)
        return acc
      },
      {} as Record<string, FeatureSetting[]>,
    )

    return Object.entries(grouped)
      .map(([group, settings]) => [
        group,
        [...settings].sort((a, b) => rankSetting(group, a.key) - rankSetting(group, b.key)),
      ] as const)
      .sort(
        ([a], [b]) =>
          (GROUP_RANK.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (GROUP_RANK.get(b) ?? Number.MAX_SAFE_INTEGER),
      )
  }, [data])

  function handleChange(key: string, value: boolean | number | string) {
    setLocalValues((prev) => ({ ...prev, [key]: value }))
  }

  function handleDiscard() {
    setLocalValues({})
  }

  function handleSave() {
    if (changedKeys.length === 0) return
    const updates: Record<string, boolean | number | string> = {}
    for (const k of changedKeys) updates[k] = localValues[k]
    saveMutation.mutate(updates)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Failed to load settings: {(error as Error).message}
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Toggle experimental features and tune parameters. Changes marked with ↻ restart require a server restart to take effect."
      />

      {data?.pendingRestart && (
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Some changes require a server restart to take effect.
        </div>
      )}

      <div className="space-y-6">
        {groups.map(([group, settings]) => (
          <SettingsSection
            key={group}
            title={group}
            settings={settings}
            localValues={localValues}
            onChange={handleChange}
          />
        ))}
      </div>

      {hasRestartChanges && hasChanges && (
        <p className="mt-4 text-xs text-muted-foreground text-center">
          Some changed settings require a server restart.
        </p>
      )}

      <FloatingBar show={hasChanges}>
        <span className="text-xs text-muted-foreground">
          {changedKeys.length} unsaved change{changedKeys.length !== 1 ? 's' : ''}
        </span>
        <Button variant="outline" size="sm" onClick={handleDiscard}>
          Discard
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            'Save'
          )}
        </Button>
      </FloatingBar>
    </div>
  )
}
