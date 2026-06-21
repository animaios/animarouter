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

  // Group settings by `group` field
  const groups = useMemo(() => {
    if (!data?.settings) return {}
    return data.settings.reduce(
      (acc, s) => {
        (acc[s.group] ??= []).push(s)
        return acc
      },
      {} as Record<string, FeatureSetting[]>,
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
        {Object.entries(groups).map(([group, settings]) => (
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
