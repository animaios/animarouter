import { useId } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Live filter input used by the Models pages.
 *
 * Search behaviour (per-product spec):
 *  - case-insensitive
 *  - matches within displayName, modelId, AND platform
 *  - match can be at start, middle, or end — no anchors
 *  - the query is normalised before matching: spaces, dashes, dots,
 *    underscores, slashes, colons all collapse to a single non-token so
 *    "kimi k2.6" and "kimi-k2-6" both hit the same id (see
 *    normalizeForSearch below). This is what makes typing
 *    `kimi k2.6` land on ids that contain `kimi-k2.6`.
 *  - multi-token AND: each whitespace-separated token must match
 *    somewhere across all fields; supports queries like "qwen 32b".
 *
 * Cheap enough to run on every keystroke: the model arrays are bounded
 * (~750 entries today) and `filter` is O(n) over strings of <100 chars
 * each, so debouncing would add complexity without buying anything.
 */
const TOKEN_CHARS_RE = /[\s._/:+\-]+/g

/** Lowercase + collapse every "skip" character to a space, then re-trim. */
export function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(TOKEN_CHARS_RE, ' ').replace(/\s+/g, ' ').trim()
}

export type SearchableModel = { displayName: string; modelId: string; platform: string }

/**
 * Pure filter helper. All callers go through this so the match rules stay
 * consistent across pages.
 *
 * When model_grouping_enabled is true, callers may pass group-level fields
 * (groupKey, displayName from the group) or provider-level fields — the
 * same normalisation + multi-token AND logic applies either way.
 * TODO: Add group-aware search mode that matches against groupKey and
 *       group display_name, expanding matched groups to show all providers.
 */
export function matchesModelQuery(query: string, fields: SearchableModel): boolean {
  const q = normalizeForSearch(query)
  if (q.length === 0) return true
  // Build the haystack once per row. Single .toLowerCase() + normalize
  // pass per model — much cheaper than normalising each field separately.
  const haystack = normalizeForSearch(
    `${fields.displayName} ${fields.modelId} ${fields.platform}`,
  )
  const tokens = q.split(' ')
  for (const token of tokens) {
    if (token.length === 0) continue
    if (!haystack.includes(token)) return false
  }
  return true
}

export function ModelSearchBox({
  value,
  onChange,
  placeholder = 'Filter models…',
  showCount,
  total,
  matched,
  className,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  /** Optional "X of Y" count next to the input — hides when value is empty. */
  showCount?: boolean
  total?: number
  matched?: number
  className?: string
}) {
  const id = useId()
  return (
    <div className={cn('w-full sm:max-w-xs', className)}>
      <div className="relative h-8">
        <Search
          className="pointer-events-none absolute left-2.5 top-0 bottom-0 m-auto size-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          id={id}
          // type="text" (not "search") so the browser's UA styles don't grow
          // the line box while typing — that used to push the absolutely-
          // positioned icons down out of bounds.
          type="text"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape' && value !== '') { e.preventDefault(); onChange('') } }}
          placeholder={placeholder}
          aria-label="Filter models"
          // Hide the WebKit/Blink native clear-button — we render our own.
          className="peer h-8 w-full rounded-lg border border-input bg-background pl-8 pr-8 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:border-ring transition-colors [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
        />
        {value !== '' && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Clear filter"
            className="absolute right-2 top-0 bottom-0 m-auto inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {showCount && value !== '' && typeof total === 'number' && typeof matched === 'number' && (
        <p className="mt-1.5 text-[11px] text-muted-foreground" aria-live="polite">
          Showing {matched} of {total}
        </p>
      )}
    </div>
  )
}
