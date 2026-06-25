import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card'
import { SettingRow } from '@/components/setting-row'
import type { FeatureSetting } from '@/lib/api'

interface SettingsSectionProps {
  title: string
  settings: FeatureSetting[]
  localValues: Record<string, boolean | number | string>
  onChange: (key: string, value: boolean | number | string) => void
}

export function SettingsSection({ title, settings, localValues, onChange }: SettingsSectionProps) {
  /** Resolve a setting's current effective value (local override → server value). */
  function getValue(key: string): boolean | number | string {
    if (key in localValues) return localValues[key]
    const s = settings.find((s) => s.key === key)
    return s?.value ?? false
  }

  /** Check if a setting should be disabled — either its parentToggle is OFF or its disableWhen setting is ON. */
  function isSettingDisabled(setting: typeof settings[0]): boolean {
    // parentToggle: disabled when parent is OFF
    if (setting.parentToggle) {
      const val = getValue(setting.parentToggle)
      if (val === false || val === 'off') return true
    }
    // disableWhen: disabled when the referenced setting is ON
    if (setting.disableWhen) {
      const val = getValue(setting.disableWhen)
      if (val === true || val === 'on' || val === 'true') return true
    }
    return false
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          {settings.map((setting) => {
            const disabled = isSettingDisabled(setting)
            return (
              <SettingRow
                key={setting.key}
                setting={setting}
                value={getValue(setting.key)}
                onChange={(v) => onChange(setting.key, v)}
                disabled={disabled}
              />
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
