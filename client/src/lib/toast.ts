/**
 * Tiny toast bus with localStorage replay.
 *
 * Why a hand-rolled bus instead of sonner/radix-toast? The dashboard is
 * small and we never block on the toast surface — adding a dep is more
 * weight than a 60-line module. The bus gives us:
 *   - process-local fan-out (mounted Toaster)
 *   - replay-on-next-visit via `pending_toasts` (so toasts fired while
 *     the user was away still surface on their next open)
 *
 * Public surface:
 *   addToast({kind, title, description?, details?, sticky?, href?})
 *   subscribe(fn)             — Toaster subscribes once
 *   drainPersisted()          — App.tsx calls once on mount to replay
 *   dismissToast(id), dismissAll(), clearPersisted()
 */

export type ToastKind = "info" | "success" | "warning";

export type Toast = {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  /** Optional list of additive items (e.g. newly discovered model ids). */
  details?: string[];
  /** Sticky toasts survive the 8s auto-dismiss timer. */
  sticky?: boolean;
  /** URL to navigate when the user clicks the toast body. */
  href?: string;
  /** Epoch ms — used for ordering and dedup. */
  ts: number;
};

const STORAGE_KEY = "pending_toasts";

const isValidToast = (x: unknown): x is Toast =>
  !!x &&
  typeof x === "object" &&
  typeof (x as Toast).id === "string" &&
  typeof (x as Toast).title === "string" &&
  typeof (x as Toast).ts === "number";

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/** Fire a toast. If the tab is hidden, also persist so the next visit shows it. */
export function addToast(input: Omit<Toast, "id" | "ts">): void {
  const toast: Toast = { ...input, id: newId(), ts: Date.now() };

  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    const queued = readPersisted();
    writePersisted([...queued, toast]);
  }

  emit((active) => [...active, toast]);
}

/** The Toaster calls this on close/timer. */
export function dismissToast(id: string): void {
  emit((active) => active.filter((t) => t.id !== id));
}

/** Wipe on-screen toasts (used by "Dismiss all"). Does NOT clear LS. */
export function dismissAll(): void {
  emit(() => []);
}

/** Clear the persisted queue without affecting on-screen toasts. */
export function clearPersisted(): void {
  writePersisted([]);
}

export function subscribe(fn: (toasts: Toast[]) => void): () => void {
  listeners.add(fn);
  fn(toastStore);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Replay toasts queued while the user was away. Called once on App mount;
 * consumer subscribes BEFORE calling so the bus already has listeners.
 */
export function drainPersisted(): void {
  const queued = readPersisted();
  if (queued.length === 0) return;
  emit((active) => [...active, ...queued]);
  writePersisted([]);
}

// ── internal store: pub/sub hides the active array. ──────────────────────────
let toastStore: Toast[] = [];
const listeners = new Set<(toasts: Toast[]) => void>();

function emit(mutator: (current: Toast[]) => Toast[]): void {
  toastStore = mutator(toastStore);
  for (const fn of listeners) fn(toastStore);
}

function readPersisted(): Toast[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Toast[];
    return Array.isArray(arr) ? arr.filter(isValidToast) : [];
  } catch {
    return [];
  }
}

function writePersisted(toasts: Toast[]): void {
  try {
    if (toasts.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(toasts));
  } catch {
    /* quota / disabled — silently drop */
  }
}
