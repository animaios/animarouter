import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { Markdown } from '@/components/markdown'

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
  keyCount: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  meta?: {
    platform?: string
    model?: string
    latency?: number
    fallbackAttempts?: number
    streaming?: boolean
  }
}

export default function PlaygroundPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('auto')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  // ── Error formatting (Fix 5) ──────────────────────────────────────────────
  const formatError = useCallback((status: number, body: any): string => {
    const errType: string = body?.error?.type ?? ''
    const errMsg: string = body?.error?.message ?? `HTTP ${status}`
    if (status === 401 || errType === 'authentication_error')
      return `🔑 Invalid API key. Regenerate it in Settings.`
    if (status === 429 || errType === 'rate_limit_error')
      return `⚠️ ${errMsg}`
    if (status === 400 || errType === 'invalid_request_error')
      return `⚠️ ${errMsg}`
    if (status >= 500)
      return `🔌 Upstream provider error — the model returned an error.`
    return `❌ ${errMsg}`
  }, [])

  // ── Streaming send (Fixes 3, 4, 6) ────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return

    const userMsg: ChatMessage = { role: 'user', content: text }
    const assistantMsg: ChatMessage = { role: 'assistant', content: '' }
    setMessages(prev => [...prev, userMsg, assistantMsg])
    setInput('')
    setLoading(true)
    inputRef.current?.focus()

    const controller = new AbortController()
    abortRef.current = controller
    const timeoutId = setTimeout(() => controller.abort(), 120_000)

    let content = ''
    let routedPlatform = ''
    let routedModel = ''
    let fallbackCount = 0
    let latency = 0
    const start = Date.now()

    // Throttled UI flush — updates the streaming message at ~30fps
    let pending = false
    const flush = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        if (!mountedRef.current) return
        pending = false
        setMessages(prev => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last?.role === 'assistant') {
            copy[copy.length - 1] = {
              ...last,
              content,
              meta: {
                platform: routedPlatform || undefined,
                model: routedModel || undefined,
                latency: undefined, // shown only when complete
                fallbackAttempts: fallbackCount > 0 ? fallbackCount : undefined,
                streaming: true,
              },
            }
          }
          return copy
        })
      })
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const body: any = {
        messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })),
        stream: true,
      }
      if (selectedModel !== 'auto') body.model = selectedModel

      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      // Read routing info from response headers (Fix 4)
      const routedVia = res.headers.get('X-Routed-Via')
      if (routedVia) {
        const slash = routedVia.indexOf('/')
        routedPlatform = slash === -1 ? routedVia : routedVia.slice(0, slash)
        routedModel = slash === -1 ? '' : routedVia.slice(slash + 1)
      }
      fallbackCount = parseInt(res.headers.get('X-Fallback-Attempts') ?? '0', 10)
      flush()

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        content = formatError(res.status, errBody)
        latency = Date.now() - start
        if (!mountedRef.current) {
          return
        }
        setMessages(prev => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last?.role === 'assistant') {
            copy[copy.length - 1] = {
              ...last,
              content,
              meta: {
                platform: routedPlatform || undefined,
                model: routedModel || undefined,
                latency,
                fallbackAttempts: fallbackCount > 0 ? fallbackCount : undefined,
              },
            }
          }
          return copy
        })
        return
      }

      // Stream the response (Fix 3)
      const reader = res.body?.getReader()
      if (!reader) {
        content = '❌ No response body — the server closed the connection.'
        latency = Date.now() - start
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6)

          if (payload === '[DONE]') {
            reader.cancel()
            break
          }

          try {
            const chunk = JSON.parse(payload)
            // In-band error frame (e.g. mid-stream provider error)
            if (chunk.error) {
              content += content ? '\n\n' : ''
              content += `⚠️ ${chunk.error.message ?? 'Stream error'}`
              reader.cancel()
              latency = Date.now() - start
              break
            }
            const delta = chunk.choices?.[0]?.delta?.content ?? ''
            if (delta) {
              content += delta
              flush()
            }
          } catch {
            // ignore unparseable chunks
          }
        }
      }

      latency = Date.now() - start
    } catch (err: any) {
      latency = Date.now() - start
      if (err.name === 'AbortError') {
        if (!content) content = '(cancelled)'
      } else if (err.message === 'Failed to fetch') {
        content = '🔌 Connection failed — is the server running?'
      } else {
        content = `❌ ${err.message}`
      }
    } finally {
      clearTimeout(timeoutId)
      abortRef.current = null
      if (!mountedRef.current) return
      setLoading(false)
      // Final update with complete metadata
      setMessages(prev => {
        const copy = [...prev]
        const last = copy[copy.length - 1]
        if (last?.role === 'assistant') {
          copy[copy.length - 1] = {
            ...last,
            content: content || '(empty response)',
            meta: {
              platform: routedPlatform || undefined,
              model: routedModel || undefined,
              latency: latency > 0 ? latency : undefined,
              fallbackAttempts: fallbackCount > 0 ? fallbackCount : undefined,
            },
          }
        }
        return copy
      })
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [input, loading, messages, keyData, selectedModel])

  const handleCancel = () => {
    abortRef.current?.abort()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (loading) return
      handleSend()
    }
  }

  const handleClear = () => {
    setMessages([])
    inputRef.current?.focus()
  }

  const activeModelLabel = selectedModel === 'auto'
    ? 'Auto (fallback chain)'
    : availableModels.find(m => m.modelId === selectedModel)?.displayName ?? selectedModel

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <PageHeader
        title="Playground"
        description="Send a chat completion through the router and see which provider serves it."
        actions={
          <>
            <Select value={selectedModel} onValueChange={(v) => setSelectedModel(v ?? 'auto')}>
              <SelectTrigger className="w-[260px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (fallback chain)</SelectItem>
                {availableModels.map(m => (
                  <SelectItem key={m.modelDbId} value={m.modelId}>
                    <span className="flex items-center gap-2">
                      <span>{m.displayName}</span>
                      <span className="text-xs text-muted-foreground">{m.platform}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {messages.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleClear}>
                Clear
              </Button>
            )}
          </>
        }
      />

      <div className="flex-1 flex flex-col rounded-3xl border bg-card overflow-hidden min-h-0">
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center">
              <div className="space-y-2 max-w-sm">
                <p className="text-base font-medium">Send a message to get started.</p>
                <p className="text-sm text-muted-foreground">
                  Using <span className="text-foreground">{activeModelLabel}</span>. Switch models in the selector above.
                </p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <span>
                        <Markdown>{msg.content}</Markdown>
                        {msg.meta?.streaming && (
                          <span className="inline-block w-1.5 h-4 bg-foreground/60 ml-0.5 align-text-bottom animate-pulse rounded-sm" />
                        )}
                      </span>
                    ) : (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    )}
                    {msg.meta && !msg.meta.streaming && (
                      <div className="flex items-center gap-2 mt-2 flex-wrap text-[11px] opacity-70 tabular-nums">
                        {msg.meta.platform && <span>{msg.meta.platform}</span>}
                        {msg.meta.model && <span className="font-mono">· {msg.meta.model}</span>}
                        {msg.meta.latency != null && <span>· {msg.meta.latency} ms</span>}
                        {msg.meta.fallbackAttempts != null && msg.meta.fallbackAttempts > 0 && (
                          <span>· {msg.meta.fallbackAttempts} fallback{msg.meta.fallbackAttempts > 1 ? 's' : ''}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {loading && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-2xl px-4 py-3">
                    <div className="flex gap-1">
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        <div className="border-t bg-background/50 p-3">
          <div className="flex gap-2 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message… (⏎ to send, ⇧⏎ for newline)"
              rows={1}
              className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 min-h-[40px] max-h-[160px]"
              style={{ height: 'auto', overflow: 'hidden' }}
              onInput={e => {
                const el = e.target as HTMLTextAreaElement
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 160) + 'px'
              }}
            />
            {loading ? (
              <Button onClick={handleCancel} variant="outline" size="default">
                Cancel
              </Button>
            ) : (
              <Button onClick={handleSend} disabled={!input.trim()} size="default">
                Send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
