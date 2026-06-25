import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp } from 'lucide-react';

// Mirrors server/src/services/events.ts LiveEvent union.
// Events with a request-scoped `id` use RequestEventBase;
// standalone events (heartbeat, stream) carry only `at`.
interface RequestEventBase {
  id: string;
  at: number;
}

interface TimestampOnly {
  at: number;
}

interface RequestStartEvent extends RequestEventBase { type: 'request.start'; model?: string; stream: boolean; }
interface RequestDoneEvent extends RequestEventBase { type: 'request.done'; model: string; provider: string; keyId: number; latencyMs: number; tokens?: { in: number; out: number }; }
interface RequestErrorEvent extends RequestEventBase { type: 'request.error'; error: string; }
interface RequestAbortedEvent extends RequestEventBase { type: 'request.aborted'; }
interface KeyExhaustedEvent extends RequestEventBase { type: 'routing.key_exhausted'; provider: string; keyId: number; model: string; reason: string; }
interface ModelSwitchEvent extends RequestEventBase { type: 'routing.model_switch'; from: string; to: string; reason: string; }
interface ProviderFastFailEvent extends RequestEventBase { type: 'routing.provider_fastfail'; provider: string; failedModelCount: number; }
interface KeyEvictedEvent extends RequestEventBase { type: 'routing.key_evicted'; provider: string; keyId: number; model: string; reason: 'rate_limited' | 'payment_required' | 'auth_error'; }
interface HeartbeatPingEvent extends TimestampOnly { type: 'heartbeat.ping'; provider: string; model: string; keyId: number; success: boolean; latencyMs: number; error?: string; }
interface HeartbeatCycleSkippedEvent extends TimestampOnly { type: 'heartbeat.cycle_skipped'; reason: string; lastActivityAgeMs: number; }
interface HeartbeatAutoDisableEvent extends TimestampOnly {
  type: 'heartbeat.auto_disable';
  provider: string;
  model: string;
  modelDbId: number;
  totalKeys: number;
  unhealthyKeys: number;
  threshold: number;
}
interface StreamChunkEvent extends RequestEventBase { type: 'stream.chunk'; text: string; }

type LiveEvent =
  | RequestStartEvent | RequestDoneEvent | RequestErrorEvent | RequestAbortedEvent
  | KeyExhaustedEvent | ModelSwitchEvent | ProviderFastFailEvent
  | KeyEvictedEvent
  | HeartbeatPingEvent | HeartbeatCycleSkippedEvent | HeartbeatAutoDisableEvent
  | StreamChunkEvent;

/** Exhaustive-check helper: assigning a LiveEvent to this type in a switch
 *  default branch will cause a compile error if any variant is unhandled. */
type ExhaustiveEventCheck = never;

interface LogEntry {
  id: string | undefined;
  text: string;
  ts: number;
  kind: 'start' | 'done' | 'error' | 'info' | 'warn';
}

const MAX_LOG_LINES = 200;

function formatEvent(evt: LiveEvent): LogEntry | null {
  const ts = evt.at;
  switch (evt.type) {
    case 'request.start': {
      const rId = evt.id.slice(0, 8);
      return { id: evt.id, ts, kind: 'start', text: `▶ [${rId}] Request started${evt.model ? ` (pinned: ${evt.model})` : ' (auto)'} — ${evt.stream ? 'streaming' : 'non-stream'}` };
    }
    case 'request.done': {
      const rId = evt.id.slice(0, 8);
      return { id: evt.id, ts, kind: 'done', text: `✓ [${rId}] ${evt.provider}/${evt.model} key#${evt.keyId} — ${evt.latencyMs}ms${evt.tokens ? `, ${evt.tokens.in}↓/${evt.tokens.out}↑ tokens` : ''}` };
    }
    case 'request.error': {
      const rId = evt.id.slice(0, 8);
      return { id: evt.id, ts, kind: 'error', text: `✗ [${rId}] ${evt.error}` };
    }
    case 'request.aborted': {
      const rId = evt.id.slice(0, 8);
      return { id: evt.id, ts, kind: 'info', text: `⬛ [${rId}] Request aborted by client` };
    }
    case 'routing.key_exhausted': {
      const rId = evt.id.slice(0, 8);
      return { id: evt.id, ts, kind: 'info', text: `⚠ [${rId}] Key #${evt.keyId} exhausted on ${evt.provider}/${evt.model}: ${evt.reason.slice(0, 80)}` };
    }
    case 'routing.model_switch': {
      const rId = evt.id.slice(0, 8);
      return { id: evt.id, ts, kind: 'info', text: `→ [${rId}] Switching model: ${evt.from} → ${evt.to}` };
    }
    case 'routing.provider_fastfail': {
      const rId = evt.id.slice(0, 8);
      return { id: evt.id, ts, kind: 'warn', text: `⚡ [${rId}] Provider ${evt.provider} fast-failed (${evt.failedModelCount} models down) — skipping remaining models` };
    }
    case 'routing.key_evicted': {
      const rId = evt.id.slice(0, 8);
      return { id: evt.id, ts, kind: 'warn',
        text: `🚫 [${rId}] Key #${evt.keyId} evicted (${evt.reason === 'rate_limited' ? '429 rate limit' : evt.reason === 'payment_required' ? '402 out of credits' : 'auth error'}) on ${evt.provider}/${evt.model}`
    }
    case 'heartbeat.ping':
      if (evt.success) {
        return { id: 'hb', ts, kind: 'info', text: `♥ [heartbeat] ${evt.provider}/${evt.model} key#${evt.keyId} healthy (${evt.latencyMs}ms)` };
      }
      return { id: 'hb', ts, kind: 'warn', text: `♥ [heartbeat] ${evt.provider}/${evt.model} key#${evt.keyId} FAILED: ${evt.error?.slice(0, 60) ?? 'unknown'}` };
    case 'heartbeat.cycle_skipped':
      return { id: 'hb', ts, kind: 'info', text: `♥ [heartbeat] Cycle skipped: ${evt.reason} (idle ${Math.round(evt.lastActivityAgeMs / 1000)}s)` };
    case 'heartbeat.auto_disable':
      return { id: 'hb', ts, kind: 'warn',
        text: `\u{1F916} Auto-disabled ${evt.provider}/${evt.model}: ${evt.unhealthyKeys}/${evt.totalKeys} keys unhealthy (threshold ${evt.threshold}%)` };
    case 'stream.chunk':
      return null; // Stream chunks are not rendered in the log feed
    default: {
      // Exhaustive check: if a new event type is added to LiveEvent but not
      // handled above, the compiler will error here.
      const _exhaustive: ExhaustiveEventCheck = evt;
      void _exhaustive;
      return null;
    }
  }
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function LiveEvents() {
  const [expanded, setExpanded] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(new Set<string>());
  const addLine = useCallback((entry: LogEntry) => {
    setLines(prev => {
      const next = [...prev, entry];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as LiveEvent;
        const entry = formatEvent(evt);

        if (evt.type === 'request.start' && evt.id) {
          activeRef.current.add(evt.id);
          setActiveCount(activeRef.current.size);
        } else if ((evt.type === 'request.done' || evt.type === 'request.error') && evt.id) {
          activeRef.current.delete(evt.id);
          setActiveCount(activeRef.current.size);
        }

        if (entry) addLine(entry);
      } catch { /* malformed event — skip */ }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; just wait.
    };
    return () => es.close();
  }, [addLine]);


  // Auto-scroll only the terminal container — never the page.
  // Double-fire: immediate set catches the common case; rAF catches
  // late layout when content height is still settling after React commit.
  useEffect(() => {
    if (!autoScroll || !logContainerRef.current) return;
    const el = logContainerRef.current;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [lines.length, autoScroll]);

  const clearLogs = () => setLines([]);

  return (
    <div className="rounded-3xl border bg-card mb-6">
      {/* Header bar — always visible */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium">Live Feed</h3>
          {activeCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </span>
              {activeCount} active
            </span>
          )}
          {lines.length > 0 && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {lines.length} lines
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant={autoScroll ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => setAutoScroll(v => !v)}
            title={autoScroll ? 'Auto-scroll ON — click to pause' : 'Auto-scroll OFF — click to resume'}
            className="gap-1.5"
          >
            <span className={`relative flex size-2 ${autoScroll ? '' : 'opacity-40'}`}>
              <span className={`absolute inline-flex h-full w-full rounded-full ${autoScroll ? 'animate-ping bg-emerald-400 opacity-75' : 'bg-muted-foreground'}`} />
              <span className={`relative inline-flex size-2 rounded-full ${autoScroll ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
            </span>
            Live
          </Button>
          <Button variant="ghost" size="xs" onClick={clearLogs} title="Clear log">
            Clear
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={() => setExpanded(v => !v)} title={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
        </div>
      </div>
      {/* Log area */}
      <div
        ref={logContainerRef}
        className={`overflow-y-auto font-mono text-[11px] leading-relaxed bg-muted text-muted-foreground rounded-b-3xl transition-all duration-200 ${
          expanded ? 'max-h-[480px]' : 'max-h-36'
        }`}
      >
        {lines.length === 0 ? (
          <div className="px-4 py-6 text-center text-muted-foreground/50 text-xs">
            Waiting for requests… Open a new terminal and send a request to see live routing activity.
          </div>
        ) : (
          <div className="py-1.5">
            {lines.map((l, i) => (
              <div
                key={`${l.id}-${i}`}
                className={`px-4 py-0.5 whitespace-pre-wrap break-all ${
                  l.kind === 'error' ? 'text-rose-600 dark:text-rose-400 bg-rose-500/10'
                  : l.kind === 'done' ? 'text-emerald-600 dark:text-emerald-400'
                  : l.kind === 'start' ? 'text-sky-600 dark:text-sky-400'
                  : l.kind === 'warn' ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
                }`}
              >
                <span className="text-muted-foreground/50 mr-2 select-none tabular-nums">{timeLabel(l.ts)}</span>
                {l.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
