import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  dismissAll,
  dismissToast,
  subscribe,
  type Toast,
  type ToastKind,
} from "@/lib/toast";

const AUTO_DISMISS_MS = 8000;

const kindColorClass: Record<ToastKind, string> = {
  info: "border-border bg-card text-card-foreground",
  success: "border-emerald-500/40 bg-emerald-500/10 text-foreground",
  warning: "border-amber-500/50 bg-amber-500/10 text-foreground",
};

const kindGlyph: Record<ToastKind, string> = {
  info: "i",
  success: "✓",
  warning: "!",
};

const kindGlyphClass: Record<ToastKind, string> = {
  info: "bg-muted text-muted-foreground",
  success: "bg-emerald-500 text-white",
  warning: "bg-amber-500 text-white",
};

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribe(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div
      // Bottom-right; mirror in RTL is auto via logical properties.
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-4 right-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.length > 1 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={dismissAll}
            className="rounded-full bg-background/80 px-2.5 py-1 text-xs text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground"
          >
            Dismiss all
          </button>
        </div>
      )}
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const [expanded, setExpanded] = useState(false);
  const [exiting, setExiting] = useState(false);

  const close = useCallback(() => {
    setExiting(true);
    // 150ms matches the duration used in the fade-out class so the
    // element is gone before the parent re-renders without it.
    window.setTimeout(() => dismissToast(toast.id), 150);
  }, [toast.id]);

  useEffect(() => {
    if (toast.sticky) return;
    const t = window.setTimeout(close, AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [toast.sticky, close]);

  const body = (
    <div
      className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 shadow-md backdrop-blur-sm transition-opacity duration-150 ${kindColorClass[toast.kind]} ${exiting ? "opacity-0" : "opacity-100"}`}
      onClick={() =>
        toast.details && toast.details.length > 0 && setExpanded((v) => !v)
      }
      role={toast.details && toast.details.length > 0 ? "button" : undefined}
    >
      <span
        className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${kindGlyphClass[toast.kind]}`}
        aria-label={toast.kind}
      >
        {kindGlyph[toast.kind]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-sm font-medium">{toast.title}</p>
          {toast.details && toast.details.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {expanded ? (
                <ChevronDown className="inline h-3 w-3 align-text-bottom" />
              ) : (
                <ChevronRight className="inline h-3 w-3 align-text-bottom" />
              )}
              {toast.details.length}
            </span>
          )}
        </div>
        {toast.description && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {toast.description}
          </p>
        )}
        {expanded && toast.details && toast.details.length > 0 && (
          <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-auto rounded-md bg-background/40 px-2 py-1.5 text-xs">
            {toast.details.map((line, i) => (
              <li key={i} className="font-mono text-foreground/80 break-all">
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          close();
        }}
        aria-label="Dismiss"
        className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  return toast.href ? (
    <Link to={toast.href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}
