import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { FeatureSetting } from '@/lib/api'

interface SettingRowProps {
  setting: FeatureSetting
  value: boolean | number | string
  onChange: (v: boolean | number | string) => void
  disabled?: boolean
}

export function SettingRow({ setting, value, onChange, disabled }: SettingRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Label htmlFor={`setting-${setting.key}`}>{setting.label}</Label>
          {setting.effect === 'restart' && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 leading-tight">
              ↻ restart
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">{setting.description}</p>
      </div>
      <div className="shrink-0 pt-0.5">
        {setting.type === 'boolean' ? (
          <Switch
            id={`setting-${setting.key}`}
            checked={value as boolean}
            onCheckedChange={(checked) => onChange(checked)}
            disabled={disabled}
          />
        ) : setting.type === 'string' && setting.options ? (
          <Select
            value={String(value ?? setting.default)}
            onValueChange={(val) => onChange(val as string)}
            disabled={disabled}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {setting.options.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt.replace(/_/g, ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : setting.type === 'string' ? (
          <Input
            id={`setting-${setting.key}`}
            type="text"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="w-[260px]"
            disabled={disabled}
          />
        ) : (
          <Input
            id={`setting-${setting.key}`}
            type="number"
            value={value as number}
            min={setting.min}
            max={setting.max}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (!isNaN(v)) onChange(v)
            }}
            onBlur={(e) => {
              // Clamp on blur for friendlier UX
              let v = parseFloat(e.target.value)
              if (isNaN(v)) v = setting.default as number
              if (setting.min !== undefined && v < setting.min) v = setting.min
              if (setting.max !== undefined && v > setting.max) v = setting.max
              onChange(v)
            }}
            className="w-20 text-center"
            disabled={disabled}
          />
        )}
      </div>
    </div>
  )
}
