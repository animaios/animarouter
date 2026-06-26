import { addToast } from '@/lib/toast'
import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import type { ApiKey, Platform, CustomProvider, Model, OutboundTransport } from '../../../shared/types'
import { Pencil, ExternalLink, Plus, X } from 'lucide-react'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'

// Small "Get API key" external link shown next to a provider (#137).
function GetKeyLink({ url }: { url: string }) {
  if (!url) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      Get API key
      <ExternalLink className="size-3" />
    </a>
  )
}

// `url` points to each provider's key-management / signup page so the Keys page
// can show a "Get API key" shortcut (#137). OpenCode Zen's key is free from
// opencode.ai/auth — no card needed; billing only applies to paid models (#128).
// `keyless: true` providers (Kilo's anonymous free tier) need no API key — the
// form disables the key field and submits a sentinel the backend stores so
// routing treats the platform as configured.
const PLATFORMS: { value: Platform; label: string; url: string; keyless?: boolean }[] = [
  { value: 'google', label: 'Google AI Studio', url: 'https://aistudio.google.com/apikey' },
  { value: 'groq', label: 'Groq', url: 'https://console.groq.com/keys' },
  { value: 'cerebras', label: 'Cerebras', url: 'https://cloud.cerebras.ai' },
  { value: 'nvidia', label: 'NVIDIA NIM', url: 'https://build.nvidia.com/settings/api-keys' },
  { value: 'mistral', label: 'Mistral', url: 'https://console.mistral.com/api-keys/' },
  { value: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/keys' },
  { value: 'github', label: 'GitHub Models', url: 'https://github.com/settings/tokens' },
  { value: 'cohere', label: 'Cohere', url: 'https://dashboard.cohere.com/api-keys' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI', url: 'https://dash.cloudflare.com' },
  { value: 'zhipu', label: 'Zhipu AI (Z.ai)', url: 'https://z.ai/manage-apikey/apikey-list' },
  { value: 'ollama', label: 'Ollama Cloud', url: 'https://ollama.com/settings/keys' },
  { value: 'kilo', label: 'Kilo Gateway (no key needed)', url: 'https://app.kilo.ai', keyless: true },
  { value: 'pollinations', label: 'Pollinations (no key needed)', url: 'https://pollinations.ai', keyless: true },
  { value: 'ovh', label: 'OVH AI Endpoints (no key needed)', url: 'https://endpoints.ai.cloud.ovh.net', keyless: true },
  { value: 'llm7', label: 'LLM7 (anon ok)', url: 'https://llm7.io' },
  { value: 'opencode', label: 'OpenCode Zen (free key)', url: 'https://opencode.ai/auth' },
  { value: 'commandcode', label: 'CommandCode', url: '' },
];

const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  sick: 'bg-yellow-500',
  rate_limited: 'bg-amber-500',
  invalid: 'bg-rose-500',
  error: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
}

const statusLabel: Record<string, string> = {
  healthy: 'healthy',
  sick: 'sick',
  rate_limited: 'rate-limited',
  invalid: 'invalid',
  error: 'error',
  unknown: 'unchecked',
}

interface HealthPlatform {
  platform: string
  totalKeys: number
  healthyKeys: number
  sickKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
}

interface HealthData {
  platforms: HealthPlatform[]
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[]
}

function UnifiedKeySection() {
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data, isError } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  })

  const apiKey = data?.apiKey ?? ''
  const masked = apiKey ? apiKey.slice(0, 13) + '•'.repeat(32) : '…'
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`

  function copy() {
    navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">Your unified API key</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Use this as your OpenAI <code className="font-mono">api_key</code>; it authenticates requests to this proxy.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending || isError}
        >
          Regenerate
        </Button>
      </div>

      {isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          Can't reach the server on <code className="font-mono">{baseUrl.replace('/v1', '')}</code>. Make sure the
          backend is running. <code className="font-mono">npm run dev</code> starts both, and the server logs print
          under the <code className="font-mono">server</code> prefix.
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all truncate tabular-nums">
            {showKey ? apiKey : masked}
          </code>
          <Button variant="outline" size="sm" onClick={() => setShowKey(!showKey)}>
            {showKey ? 'Hide' : 'Show'}
          </Button>
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">Base URL</span>
        <code className="font-mono">{baseUrl}</code>
        <span className="text-muted-foreground">Chat</span>
        <code className="font-mono">/v1/chat/completions</code>
        <span className="text-muted-foreground">Responses</span>
        <code className="font-mono">/v1/responses</code>
        <span className="text-muted-foreground">Embeddings</span>
        <code className="font-mono">/v1/embeddings <span className="text-muted-foreground">(model: "auto" or a family from the Embeddings tab)</span></code>
      </div>
    </section>
  )
}

function RelayTransportsSection() {
  const { data: transports = [] } = useQuery<OutboundTransport[]>({
    queryKey: ['transports'],
    queryFn: () => apiFetch('/api/transports'),
  })

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium">Relay transports</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {transports.length} configured
        </span>
      </div>
      {transports.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-4">
          <p className="text-sm text-muted-foreground">
            No anonymizing relay has been deployed yet.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border divide-y bg-card overflow-hidden">
          {transports.map(t => (
            <div key={t.id} className="flex items-center gap-3 px-4 py-3">
              <span className={`size-1.5 rounded-full ${t.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">{t.name}</p>
                  <span className="text-[11px] text-muted-foreground">{t.transportId}</span>
                </div>
                <p className="text-xs text-muted-foreground font-mono truncate">{t.endpointUrl}</p>
              </div>
              <span className="text-xs text-muted-foreground">hosts {t.allowedHosts}</span>
              {t.placementRegion && (
                <span className="text-xs text-muted-foreground">{t.placementRegion}</span>
              )}
              {t.lastDeployedAt && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {formatSqliteUtcToLocalTime(t.lastDeployedAt, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Add-platform modal ────────────────────────────────────────────────────
// Modal shown by the "Add New Platform" tile in the Platforms section. Adds
// the user's first custom OpenAI-compatible endpoint to the catalog. After
// the row is created the same form lets them add models immediately.

function AddPlatformModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (slug: string) => void
}) {
  const queryClient = useQueryClient()
  const [slug, setSlug] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [rpmLimit, setRpmLimit] = useState<string>('')
  const [rpdLimit, setRpdLimit] = useState<string>('')
  const [tpmLimit, setTpmLimit] = useState<string>('')
  const [tpdLimit, setTpdLimit] = useState<string>('')
  const [parallelEnabled, setParallelEnabled] = useState(false)
  const [maxParallelRequests, setMaxParallelRequests] = useState(4)
  const [stickySessionsEnabled, setStickySessionsEnabled] = useState(false)
  const [keyless, setKeyless] = useState(false)
  const [_autoDiscover, _setAutoDiscover] = useState(true)
  const [autoEnableModels, setAutoEnableModels] = useState(false)
  const [apiFormat, setApiFormat] = useState<'openai' | 'anthropic'>('openai')

  const create = useMutation<{ slug: string }, Error, Record<string, unknown>>({
    mutationFn: (body) => apiFetch('/api/custom-providers', { method: 'POST', body: JSON.stringify(body) }) as Promise<{ slug: string }>,
    onSuccess: (data: { slug: string }) => {
      queryClient.invalidateQueries({ queryKey: ['custom-providers'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      onCreated(data.slug)
      setSlug('')
      setDisplayName('')
      setBaseUrl('')
      setShowAdvanced(false)
      setRpmLimit('')
      setRpdLimit('')
      setTpmLimit('')
      setTpdLimit('')
      setParallelEnabled(false)
      setStickySessionsEnabled(false)
      setKeyless(false)
      setAutoEnableModels(false)
      setApiFormat('openai')
    },
  })

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border bg-card p-5 shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-medium">Add a custom platform</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Point at any OpenAI-compatible endpoint: Ollama, LM Studio, llama.cpp, vLLM, a remote gateway.
              Models are auto-discovered by default. Uncheck 'Auto-enable' to have them disabled initially.
            </p>
          </div>
          <Button variant="ghost" size="xs" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <form
          onSubmit={e => {
            e.preventDefault()
            const body: Record<string, unknown> = { slug: slug.trim(), displayName: displayName.trim(), baseUrl: baseUrl.trim(), keyless, apiFormat, autoEnableModels: autoEnableModels }
            if (showAdvanced) {
              if (rpmLimit) body.rpmLimit = parseInt(rpmLimit, 10)
              if (rpdLimit) body.rpdLimit = parseInt(rpdLimit, 10)
              if (tpmLimit) body.tpmLimit = parseInt(tpmLimit, 10)
              if (tpdLimit) body.tpdLimit = parseInt(tpdLimit, 10)
              body.maxParallelRequests = parallelEnabled ? maxParallelRequests : null
              body.stickySessionsEnabled = stickySessionsEnabled
            }
            create.mutate(body)
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label className="text-xs">Slug (the platform id)</Label>
            <Input
              value={slug}
              onChange={e => setSlug(e.target.value)}
              placeholder="my-ollama"
              className="font-mono text-xs"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              Lowercase letters, digits, dashes; 2-32 chars. Cannot collide with built-in platforms.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Display name</Label>
            <Input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="My Ollama box"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Base URL</Label>
            <Input
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="http://192.168.1.10:11434/v1"
              className="font-mono text-xs"
            />
</div>
          <button
            type="button"
            onClick={() => setShowAdvanced(s => !s)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {showAdvanced ? '▾' : '▸'} Advanced
          </button>
          {showAdvanced && (
            <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">RPM limit (blank = none)</Label>
                <Input type="number" min={0} value={rpmLimit} onChange={e => setRpmLimit(e.target.value)} className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">RPD limit</Label>
                <Input type="number" min={0} value={rpdLimit} onChange={e => setRpdLimit(e.target.value)} className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">TPM limit</Label>
                <Input type="number" min={0} value={tpmLimit} onChange={e => setTpmLimit(e.target.value)} className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">TPD limit</Label>
                <Input type="number" min={0} value={tpdLimit} onChange={e => setTpdLimit(e.target.value)} className="font-mono text-xs" />
              </div>
            </div>
            <div className="border-t pt-3 mt-1">
              <Label className="text-xs">Parallel requests</Label>
              <div className="flex items-center gap-3 mt-1">
                <label className="flex items-center gap-1.5 cursor-pointer text-xs">
                  <Switch checked={parallelEnabled} onCheckedChange={setParallelEnabled} />
                  Limit
                </label>
                {parallelEnabled && (
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={maxParallelRequests}
                    onChange={e => setMaxParallelRequests(parseInt(e.target.value, 10) || 1)}
                    className="font-mono text-xs w-20"
                  />
                )}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Caps in-flight requests across all models on this provider. When at the limit, every model is skipped until a slot frees.
              </p>
            </div>
            <div className="border-t pt-3 mt-1">
              <Label className="text-xs">API format</Label>
              <p className="text-[10px] text-muted-foreground mb-1">
                OpenAI-compatible endpoints use /v1/chat/completions. Anthropic endpoints use /v1/messages.
              </p>
              <label className="flex items-center gap-2 cursor-pointer text-xs">
                <span className={apiFormat === 'openai' ? '' : 'text-muted-foreground'}>OpenAI</span>
                <Switch checked={apiFormat === 'anthropic'} onCheckedChange={c => setApiFormat(c ? 'anthropic' : 'openai')} />
                <span className={apiFormat === 'anthropic' ? '' : 'text-muted-foreground'}>Anthropic</span>
              </label>
            </div>
            <div className="border-t pt-3 mt-1">
              <Label className="text-xs">Sticky keys (cache affinity)</Label>
              <p className="text-[10px] text-muted-foreground mb-1">
                Route the same conversation to the same API key for better cache hits on providers like LongCAT.
              </p>
              <label className="flex items-center gap-2 cursor-pointer text-xs">
                <Switch checked={stickySessionsEnabled} onCheckedChange={setStickySessionsEnabled} />
                <span>{stickySessionsEnabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>
            </>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Switch checked={autoEnableModels} onCheckedChange={setAutoEnableModels} />
            <span className="text-xs text-muted-foreground">
              Auto-enable discovered models
              {autoEnableModels && (
                <span className="ml-1 text-primary">✓</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Switch checked={keyless} onCheckedChange={setKeyless} />
            <span className="text-xs text-muted-foreground">No API key required (anonymous/sentinel)</span>
          </div>
          {create.isError && (
            <p className="text-destructive text-xs">{(create.error as Error).message}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!slug || !displayName || !baseUrl || create.isPending}>
              {create.isPending ? 'Adding…' : 'Add platform'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Edit-platform modal ───────────────────────────────────────────────────
// Reused for the PATCH /api/custom-providers/:slug flow. Lets the user
// correct a typo in the baseUrl or the display name without re-registering
// the slug (which is the platform id and would orphan existing models).

function EditPlatformModal({
  slug,
  provider,
  onClose,
  onSaved,
}: {
  slug: string
  provider: CustomProvider
  onClose: () => void
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const [newSlug, setNewSlug] = useState(slug)
  const [displayName, setDisplayName] = useState(provider.displayName)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [rpmLimit, setRpmLimit] = useState(provider.rpmLimit?.toString() ?? '')
  const [rpdLimit, setRpdLimit] = useState(provider.rpdLimit?.toString() ?? '')
  const [tpmLimit, setTpmLimit] = useState(provider.tpmLimit?.toString() ?? '')
  const [tpdLimit, setTpdLimit] = useState(provider.tpdLimit?.toString() ?? '')
  const [parallelEnabled, setParallelEnabled] = useState(provider.maxParallelRequests != null)
  const [maxParallelRequests, setMaxParallelRequests] = useState(provider.maxParallelRequests ?? 4)
  const [stickySessionsEnabled, setStickySessionsEnabled] = useState(provider.stickySessionsEnabled ?? false)
  const [keyless, setKeyless] = useState(provider.keyless)
  const [apiFormat, setApiFormat] = useState<'openai' | 'anthropic'>(provider.apiFormat ?? 'openai')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/custom-providers/${slug}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-providers'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      onSaved()
    },
  })

  return (
    <div
      className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border bg-card p-5 shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-medium">Edit platform</h3>
            <p className="text-xs text-muted-foreground mt-0.5 font-mono">{slug}</p>
          </div>
          <Button variant="ghost" size="xs" onClick={onClose}><X className="size-4" /></Button>
        </div>
        <form
          onSubmit={e => {
            e.preventDefault()
            const body: Record<string, unknown> = {}
            if (newSlug.trim() !== slug) body.slug = newSlug.trim()
            if (displayName.trim() !== provider.displayName) body.displayName = displayName.trim()
            if (baseUrl.trim() !== provider.baseUrl) body.baseUrl = baseUrl.trim()
            if (rpmLimit !== (provider.rpmLimit?.toString() ?? '')) body.rpmLimit = rpmLimit ? parseInt(rpmLimit, 10) : null
            if (rpdLimit !== (provider.rpdLimit?.toString() ?? '')) body.rpdLimit = rpdLimit ? parseInt(rpdLimit, 10) : null
            if (tpmLimit !== (provider.tpmLimit?.toString() ?? '')) body.tpmLimit = tpmLimit ? parseInt(tpmLimit, 10) : null
            if (tpdLimit !== (provider.tpdLimit?.toString() ?? '')) body.tpdLimit = tpdLimit ? parseInt(tpdLimit, 10) : null
            const newMax = parallelEnabled ? maxParallelRequests : null
            if (newMax !== provider.maxParallelRequests) body.maxParallelRequests = newMax
            if (keyless !== provider.keyless) body.keyless = keyless
            if (apiFormat !== (provider.apiFormat ?? 'openai')) body.apiFormat = apiFormat
            if (stickySessionsEnabled !== (provider.stickySessionsEnabled ?? false)) body.stickySessionsEnabled = stickySessionsEnabled
            if (Object.keys(body).length === 0) { onClose(); return }
            save.mutate(body)
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label className="text-xs">Slug</Label>
            <Input value={newSlug} onChange={e => setNewSlug(e.target.value)} className="font-mono text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Display name</Label>
            <Input value={displayName} onChange={e => setDisplayName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Base URL</Label>
            <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} className="font-mono text-xs" />
          </div>
          <button type="button" onClick={() => setShowAdvanced(s => !s)} className="text-xs text-muted-foreground hover:text-foreground">
            {showAdvanced ? '▾' : '▸'} Advanced
          </button>
          {showAdvanced && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label className="text-xs">RPM limit</Label><Input type="number" min={0} value={rpmLimit} onChange={e => setRpmLimit(e.target.value)} className="font-mono text-xs" /></div>
                <div className="space-y-1.5"><Label className="text-xs">RPD limit</Label><Input type="number" min={0} value={rpdLimit} onChange={e => setRpdLimit(e.target.value)} className="font-mono text-xs" /></div>
                <div className="space-y-1.5"><Label className="text-xs">TPM limit</Label><Input type="number" min={0} value={tpmLimit} onChange={e => setTpmLimit(e.target.value)} className="font-mono text-xs" /></div>
                <div className="space-y-1.5"><Label className="text-xs">TPD limit</Label><Input type="number" min={0} value={tpdLimit} onChange={e => setTpdLimit(e.target.value)} className="font-mono text-xs" /></div>
              </div>
              <div className="border-t pt-3 mt-1">
                <Label className="text-xs">Parallel requests</Label>
                <div className="flex items-center gap-3 mt-1">
                  <label className="flex items-center gap-1.5 cursor-pointer text-xs"><Switch checked={parallelEnabled} onCheckedChange={setParallelEnabled} />Limit</label>
                  {parallelEnabled && <Input type="number" min={1} max={100} value={maxParallelRequests} onChange={e => setMaxParallelRequests(parseInt(e.target.value, 10) || 1)} className="font-mono text-xs w-20" />}
                </div>
              </div>
              <div className="border-t pt-3 mt-1">
                <Label className="text-xs">API format</Label>
                <p className="text-[10px] text-muted-foreground mb-1">
                  OpenAI-compatible endpoints use /v1/chat/completions. Anthropic endpoints use /v1/messages.
                </p>
                <label className="flex items-center gap-2 cursor-pointer text-xs">
                  <span className={apiFormat === 'openai' ? '' : 'text-muted-foreground'}>OpenAI</span>
                  <Switch checked={apiFormat === 'anthropic'} onCheckedChange={c => setApiFormat(c ? 'anthropic' : 'openai')} />
                  <span className={apiFormat === 'anthropic' ? '' : 'text-muted-foreground'}>Anthropic</span>
                </label>
              </div>
              <div className="border-t pt-3 mt-1">
                <Label className="text-xs">Sticky keys (cache affinity)</Label>
                <p className="text-[10px] text-muted-foreground mb-1">
                  Route the same conversation to the same API key for better cache hits on providers like LongCAT.
                </p>
                <label className="flex items-center gap-2 cursor-pointer text-xs">
                  <Switch checked={stickySessionsEnabled} onCheckedChange={setStickySessionsEnabled} />
                  <span>{stickySessionsEnabled ? 'Enabled' : 'Disabled'}</span>
                </label>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Switch checked={keyless} onCheckedChange={setKeyless} />
                <span className="text-xs text-muted-foreground">No API key required</span>
              </div>
            </>
          )}
          {save.isError && <p className="text-destructive text-xs">{(save.error as Error).message}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </div>
    </div>
  )
}
// Custom model registration form: adds a single model to any provider —
// built-in or custom. Defaults are chosen so the user can submit with just
// the model id and display name; the rest of the form's "advanced" fields
// take sensible defaults and can be edited later from the Fallback page.
//   contextWindow = 128_000  (matches the modern LLM ceiling)
//   supportsTools = true     (most OpenAI-compat endpoints do)
//   supportsVision = false   (text-only is the safe default)
//   ranks = 50 / 50          (middle of the bandit scoring range)
//   sizeLabel = 'Custom'     (sorts below named tiers)

function CustomModelsSection() {
  const queryClient = useQueryClient()
  const { data: customProviders = [] } = useQuery<CustomProvider[]>({
    queryKey: ['custom-providers'],
    queryFn: () => apiFetch('/api/custom-providers'),
  })
  const activeCustom = customProviders.filter(cp => !cp.archived)
  const { data: models = [] } = useQuery<Model[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
  })
  const [provider, setProvider] = useState<string | null>(null)
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [contextWindow, setContextWindow] = useState(128000)
  const [maxOutputTokens, setMaxOutputTokens] = useState(null as number | null)
  const [supportsTools, setSupportsTools] = useState(true)
  const [supportsVision, setSupportsVision] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [intelligenceRank, setIntelligenceRank] = useState(50)
  const [speedRank, setSpeedRank] = useState(50)
  const [sizeLabel, setSizeLabel] = useState('Custom')
  const deleteModel = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/custom-models/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })
  const addModel = useMutation({
    mutationFn: (body: any) =>
      apiFetch(`/api/custom-providers/${body.providerSlug}/models`, {
        method: 'POST',
        body: JSON.stringify(body.fields),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setModelId('')
      setDisplayName('')
    },
  })
  const syncAll = useMutation({
    mutationFn: () => apiFetch<{
      fetched: number
      providers: number
      errors: { slug: string; error: string }[]
      added_by_provider: Record<string, string[]>
    }>(
      '/api/models/sync-all',
      { method: 'POST' },
    ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })

      const providers = Object.keys(data.added_by_provider)
      const allAdded = providers.flatMap(s => data.added_by_provider[s])

      if (allAdded.length > 0) {
        // Group-by-provider summary in the description (e.g. "openrouter: 3, nvidia: 1")
        // and the full per-model list in `details` so clicking the toast expands it.
        const summary = providers
          .map(slug => `${slug}: ${data.added_by_provider[slug].length}`)
          .join(' · ')
        addToast({
          kind: 'success',
          title: `Discovered ${allAdded.length} new model${allAdded.length === 1 ? '' : 's'}`,
          description: summary,
          details: providers.flatMap(slug =>
            data.added_by_provider[slug].map(mid => `${slug}/${mid}`),
          ),
          sticky: true,
        })
      }

      if (data.errors.length > 0) {
        // Each provider failure is its own toast so one bad slug doesn't bury
        // the rest. The detail list contains the slug + reason text.
        const slugs = data.errors.map(e => e.slug).join(', ')
        console.warn(`Model sync errors on: ${slugs}`, data.errors)
        addToast({
          kind: 'warning',
          title: `Model sync failed for ${data.errors.length} provider${data.errors.length === 1 ? '' : 's'}`,
          description: `Affected: ${slugs}`,
          details: data.errors.map(e => `${e.slug}: ${e.error}`),
        })
      }
    },
  })
  const [autoSync, setAutoSync] = useState(() => {
    try { return localStorage.getItem('auto-discover-models') === 'true' } catch { return false }
  })
  const toggleAutoSync = (v: boolean) => {
    setAutoSync(v)
    try { localStorage.setItem('auto-discover-models', String(v)) } catch { /* ignore */ }
  }
  // Auto-sync every 5 minutes when enabled.
  useEffect(() => {
    if (!autoSync) return
    const id = setInterval(() => {
      if (!syncAll.isPending) syncAll.mutate()
    }, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [autoSync, syncAll.isPending, syncAll.mutate])
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!provider || !modelId || !displayName) return
    const fields: Record<string, unknown> = {
      modelId: modelId.trim(),
      displayName: displayName.trim(),
      contextWindow: contextWindow || null,
      maxOutputTokens: maxOutputTokens,
      supportsTools,
      supportsVision,
    }
    if (showAdvanced) {
      fields.intelligenceRank = intelligenceRank
      fields.speedRank = speedRank
      fields.sizeLabel = sizeLabel
    }
    addModel.mutate({ providerSlug: provider ?? '', fields })
  }
  // Count of registered models per platform — used to label the dropdown
  // entries so the user can see which providers already have models.
  const modelCountByPlatform = new Map<string, number>()
  for (const m of models) {
    modelCountByPlatform.set(m.platform, (modelCountByPlatform.get(m.platform) ?? 0) + 1)
  }
  const platformOptions: { value: string; label: string; sublabel: string }[] = [
    ...PLATFORMS.map(p => ({
      value: p.value as string,
      label: p.label,
      sublabel: `${modelCountByPlatform.get(p.value) ?? 0} models`,
    })),
    ...customProviders.filter(cp => !cp.archived).map(cp => ({
      value: cp.slug,
      label: `${cp.displayName} (custom)`,
      sublabel: `${modelCountByPlatform.get(cp.slug) ?? 0} models`,
    })),
  ]
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-medium">Models</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Register a model on a built-in provider (e.g. an unlisted Cerebras model) or on one of your
            custom platforms. The new model joins the fallback chain at the lowest priority — reorder in
            the Fallback tab.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground">
            <Switch checked={autoSync} onCheckedChange={toggleAutoSync} />
            Auto-discover
          </label>
          <Button variant="outline" size="sm" onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
            {syncAll.isPending ? 'Discovering…' : 'Discover Models'}
          </Button>
        </div>
      </div>
      <form onSubmit={submit} className="space-y-3 rounded-3xl border p-4 bg-card">
        <div className="space-y-1.5">
          <Label className="text-xs">Provider</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {platformOptions.map(p => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Model id</Label>
            <Input
              value={modelId}
              onChange={e => setModelId(e.target.value)}
              placeholder={provider ? `the model id your endpoint expects` : 'pick a provider first'}
              className="font-mono text-xs"
              disabled={!provider}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Display name</Label>
            <Input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="human-readable label"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Context window (tokens)</Label>
            <Input
              type="number"
              min={0}
              value={contextWindow}
              onChange={e => setContextWindow(parseInt(e.target.value, 10) || 0)}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Max output tokens</Label>
            <Input
              type="number"
              min={0}
              value={maxOutputTokens ?? ''}
              onChange={e => { const v = parseInt(e.target.value, 10); setMaxOutputTokens(v > 0 ? v : null) }}
              placeholder="no limit"
              className="font-mono text-xs"
            />
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
        <button
          type="button"
          onClick={() => setShowAdvanced(s => !s)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {showAdvanced ? '▾' : '▸'} Advanced
        </button>
        {showAdvanced && (
          <div className="space-y-3 pt-1 border-t">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Intelligence rank (1-100)</Label>
                <Input type="number" min={1} max={100} value={intelligenceRank}
                  onChange={e => setIntelligenceRank(parseInt(e.target.value, 10) || 50)}
                  className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Speed rank (1-100)</Label>
                <Input type="number" min={1} max={100} value={speedRank}
                  onChange={e => setSpeedRank(parseInt(e.target.value, 10) || 50)}
                  className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Size label</Label>
                <Input value={sizeLabel} onChange={e => setSizeLabel(e.target.value)} className="font-mono text-xs" />
              </div>
            </div>
          </div>
        )}
        <div className="flex justify-end pt-1">
          <Button type="submit" size="sm" disabled={!provider || !modelId || !displayName || addModel.isPending}>
            {addModel.isPending ? 'Adding…' : 'Add model'}
          </Button>
        </div>
        {addModel.isError && (
          <p className="text-destructive text-xs">{(addModel.error as Error).message}</p>
        )}
      </form>
      {/* List existing custom models with archive buttons */}
      {models.filter(m => activeCustom.some(cp => cp.slug === m.platform)).length > 0 && (
        <div className="mt-3 rounded-2xl border divide-y bg-card overflow-hidden max-h-64 overflow-y-auto">
          {models
            .filter(m => activeCustom.some(cp => cp.slug === m.platform))
            .map(m => (
              <div key={m.id} className="flex items-center gap-2 px-4 py-2 hover:bg-muted/40 transition-colors">
                <code className="text-xs font-mono">{m.modelId}</code>
                <span className="text-xs text-muted-foreground">{m.displayName}</span>
                <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive"
                  onClick={() => { if (confirm(`Archive model '${m.modelId}'? Re-add it to restore.`)) deleteModel.mutate(m.id) }}
                  disabled={deleteModel.isPending}>
                  Archive
                </Button>
              </div>
            ))}
        </div>
      )}
    </section>
  )
}

// Main Keys page. Renders the unified key section, the platform grid, the
// add-key form (which now lists custom slugs too), the per-platform key
// list, and the add-model form.
export default function KeysPage() {
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [useProxy, setUseProxy] = useState(false)
  const [editingKeyId, setEditingKeyId] = useState<number | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [editingProviderSlug, setEditingProviderSlug] = useState<string | null>(null)
  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })
  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })
  const { data: customProviders = [] } = useQuery<CustomProvider[]>({
    queryKey: ['custom-providers'],
    queryFn: () => apiFetch('/api/custom-providers'),
  })
  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string; useProxy?: boolean }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setPlatform('')
      setApiKey('')
      setAccountId('')
      setLabel('')
      setUseProxy(false)
    },
  })
  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })
  const deleteProvider = useMutation({
    mutationFn: (slug: string) => apiFetch(`/api/custom-providers/${slug}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-providers'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })
  const restoreProvider = useMutation({
    mutationFn: (slug: string) => {
      const cp = archivedCustom.find(c => c.slug === slug)
      return apiFetch('/api/custom-providers', {
        method: 'POST',
        body: JSON.stringify({ slug, displayName: cp?.displayName || slug, baseUrl: cp?.baseUrl || '' }),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-providers'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })
  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['health'] }),
  })
  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })
  const togglePlatform = useMutation({
    mutationFn: ({ platform, enabled }: { platform: string; enabled: boolean }) =>
      apiFetch(`/api/keys/platform/${platform}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })
  const updateKey = useMutation({
    mutationFn: ({ id, label, useProxy }: { id: number; label?: string; useProxy?: boolean }) =>
      apiFetch(`/api/keys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(label !== undefined ? { label } : {}),
          ...(useProxy !== undefined ? { useProxy } : {}),
        }),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      if (vars.label !== undefined) {
        setEditingKeyId(null)
        setEditingLabel('')
      }
    },
  })
  function startEditing(key: ApiKey) {
    setEditingKeyId(key.id)
    setEditingLabel(key.label)
  }
  function cancelEditing() {
    setEditingKeyId(null)
    setEditingLabel('')
  }
  function saveEditing(id: number) {
    if (editingLabel !== undefined) {
      updateKey.mutate({ id, label: editingLabel })
    }
  }
  useEffect(() => {
    if (editingKeyId !== null && editInputRef.current) {
      editInputRef.current.focus()
    }
  }, [editingKeyId])
  // Split custom providers so archived ones don't clutter the main list.
  const activeCustom = customProviders.filter(cp => !cp.archived)
  const archivedCustom = customProviders.filter(cp => cp.archived)

  // Build a unified platform list for the add-key form. Built-ins come
  // first; active user-added custom providers appear at the end.
  const allPlatforms: { value: string; label: string; url: string; keyless?: boolean }[] = [
    ...PLATFORMS,
    ...activeCustom.map(cp => ({ value: cp.slug, label: `${cp.displayName} (custom)`, url: '', keyless: cp.keyless })),
  ]
  const selectedPlatform = allPlatforms.find(p => p.value === platform)
  const needsAccountId = platform === 'cloudflare'
  const isKeyless = selectedPlatform?.keyless === true
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!platform) return
    if (!isKeyless && !apiKey) return
    if (needsAccountId && !accountId) return
    const key = isKeyless ? '' : (needsAccountId ? `${accountId}:${apiKey}` : apiKey)
    addKey.mutate({ platform, key, label: label || undefined, useProxy })
  }
  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null }>()
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k)
  // The "Configured providers" list groups by platform string. PLATFORMS
  // only seeds the header label; any platform string on a key (built-in
  // or custom) gets its own group.
  const grouped = allPlatforms
    .map(p => ({ ...p, keys: keys.filter(k => k.platform === p.value) }))
    .filter(p => p.keys.length > 0)
  const editingProvider = editingProviderSlug
    ? customProviders.find(p => p.slug === editingProviderSlug) ?? null
    : null
  return (
    <div>
      <PageHeader
        title="Keys"
        description="Provider credentials and the unified API key your apps connect with."
        actions={
          keys.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={checkAll.isPending}>
              {checkAll.isPending ? 'Checking…' : 'Check all'}
            </Button>
          )
        }
      />
      <div className="space-y-8">
        <UnifiedKeySection />
        <RelayTransportsSection />
        <section>
          <h2 className="text-sm font-medium mb-3">Add a provider key</h2>
          <form onSubmit={handleSubmit} className="flex flex-wrap gap-3 rounded-3xl border p-4 bg-card">
            <div className="space-y-1.5">
              <Label className="text-xs">Platform</Label>
              <Select value={platform} onValueChange={val => {
                if (val === '__add_new_platform__') { setAddOpen(true); return }
                setPlatform(val)
              }}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map(p => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                  {customProviders.length > 0 && (
                    <>
                      <SelectItem value="__divider" disabled className="text-muted-foreground">— custom —</SelectItem>
                      {customProviders.map(cp => (
                        <SelectItem key={cp.slug} value={cp.slug}>{cp.displayName} (custom)</SelectItem>
                      ))}
                    </>
                  )}
                  <SelectItem value="__add_new_platform__" className="border-t font-semibold text-muted-foreground italic">
                    <Plus className="size-4 inline mr-1" />Add New Platform
                  </SelectItem>
                </SelectContent>
              </Select>
              {selectedPlatform?.url && (
                <div className="pt-0.5"><GetKeyLink url={selectedPlatform.url} /></div>
              )}
            </div>
            {needsAccountId && (
              <div className="space-y-1.5">
                <Label className="text-xs">Account ID</Label>
                <Input
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  placeholder="a1b2c3d4…"
                  className="w-[200px] font-mono text-xs"
                />
              </div>
            )}
            <div className="space-y-1.5 flex-1 min-w-[240px]">
              <Label className="text-xs">{needsAccountId ? 'API token' : 'API key'}</Label>
              <Input
                type="password"
                value={isKeyless ? '' : apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={isKeyless ? 'No API key needed' : (needsAccountId ? 'Bearer token' : 'paste key here')}
                className="font-mono text-xs"
                disabled={isKeyless}
              />
              {isKeyless && (
                <p className="text-[11px] text-muted-foreground">
                  No API key needed: this provider's free tier is anonymous (rate-limited per IP).
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <div className="flex items-center gap-2">
                <Input
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="e.g. My production key"
                  className="w-[160px]"
                />
                <Button type="submit" size="sm" disabled={addKey.isPending || (!isKeyless && (!platform || !apiKey))}>
                  {isKeyless ? 'Enable' : addKey.isPending ? 'Adding…' : 'Add key'}
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Switch
                size="sm"
                checked={useProxy}
                onCheckedChange={setUseProxy}
              />
              <Label className="text-xs">Anonymizing relay</Label>
            </div>
          </form>
          {addKey.isError && (
            <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
          )}
        </section>
        <CustomModelsSection />
        <section>
          <h2 className="text-sm font-medium mb-3">Configured keys</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : grouped.length === 0 ? (
            <div className="rounded-3xl border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No provider keys yet. Add one above to start routing.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map(group => (
                <div key={group.value}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={group.keys.some(k => k.enabled)}
                        onCheckedChange={(checked) =>
                          togglePlatform.mutate({ platform: group.value, enabled: checked })
                        }
                        disabled={togglePlatform.isPending}
                      />
                      <h3 className="text-sm font-medium">{group.label}</h3>
                      <GetKeyLink url={group.url} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {group.keys.length} key{group.keys.length === 1 ? '' : 's'}
                      </span>
                      {customProviders.some(cp => cp.slug === group.value) && (
                        <>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground"
                            onClick={() => setEditingProviderSlug(group.value)}>
                            Edit
                          </Button>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive"
                            onClick={() => { if (confirm(`Archive provider '${group.label}' and all its models? This can be undone by re-adding.`)) deleteProvider.mutate(group.value) }}
                            disabled={deleteProvider.isPending}>
                            Archive
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="rounded-2xl border divide-y bg-card overflow-hidden">
                    {group.keys.map(k => {
                      const h = healthKeyMap.get(k.id)
                      const status = h?.status ?? k.status
                      const lastChecked = h?.lastCheckedAt
                      const isEditing = editingKeyId === k.id
                      return (
                        <div key={k.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                          <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
                          <code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>
                          {isEditing ? (
                            <Input
                              ref={editInputRef}
                              value={editingLabel}
                              onChange={e => setEditingLabel(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveEditing(k.id)
                                if (e.key === 'Escape') cancelEditing()
                              }}
                              onBlur={() => saveEditing(k.id)}
                              className="h-6 w-[160px] text-xs"
                              disabled={updateKey.isPending}
                            />
                          ) : (
                            <>{k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}</>
                          )}
                          <span className="text-xs text-muted-foreground">{statusLabel[status] ?? status}</span>
                          <div className="flex items-center gap-2">
                            <Switch
                              size="sm"
                              checked={k.useProxy}
                              onCheckedChange={(checked) => updateKey.mutate({ id: k.id, useProxy: checked })}
                              disabled={updateKey.isPending}
                            />
                            <span className="text-xs text-muted-foreground">Relay</span>
                          </div>
                          <div className="flex-1" />
                          {lastChecked && (
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                              {formatSqliteUtcToLocalTime(lastChecked, { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                          {!isEditing && (
                            <Button variant="ghost" size="xs" onClick={() => startEditing(k)}>
                              <Pencil className="size-3" />
                            </Button>
                          )}
                          <Button variant="ghost" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending}>
                            Check
                          </Button>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => deleteKey.mutate(k.id)} disabled={deleteKey.isPending}>
                            Remove
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        {archivedCustom.length > 0 && (
          <section>
            <h2 className="text-sm font-medium mb-2 text-muted-foreground">Archived providers</h2>
            <div className="rounded-2xl border divide-y bg-card overflow-hidden">
              {archivedCustom.map(cp => (
                <div key={cp.slug} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-muted-foreground">{cp.displayName}</p>
                    <p className="text-[11px] text-muted-foreground font-mono">{cp.slug}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => restoreProvider.mutate(cp.slug)}
                    disabled={restoreProvider.isPending}
                  >
                    {restoreProvider.isPending ? 'Restoring…' : 'Restore'}
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <AddPlatformModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => setAddOpen(false)}
      />
      {editingProvider && (
        <EditPlatformModal
          slug={editingProviderSlug!}
          provider={editingProvider}
          onClose={() => setEditingProviderSlug(null)}
          onSaved={() => setEditingProviderSlug(null)}
        />
      )}
    </div>
  )
}
