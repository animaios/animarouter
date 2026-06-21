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

  /** Check if a parent toggle is "off" — handles both boolean false and string 'off'. */
  function isParentDisabled(parentToggle: string | undefined): boolean {
    if (!parentToggle) return false
    const val = getValue(parentToggle)
    return val === false || val === 'off'
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          {settings.map((setting) => {
            const disabled = isParentDisabled(setting.parentToggle)
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
