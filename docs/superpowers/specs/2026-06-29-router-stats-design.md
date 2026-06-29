# Router Stats Redesign - Design

## Summary

Merge the legacy Analytics frontend tab into a new Router Stats cockpit. The first version is frontend-only: it reuses existing analytics endpoints, gives the page a stronger operational identity, adds a nested provider/model donut chart, and pilots a scoped neon/RGB visual system without changing backend contracts.

## Goals

- Rename and reframe Analytics as Router Stats.
- Preserve existing analytics behavior and data sources.
- Add a colorful nested donut chart for provider and model traffic mix.
- Keep the stacked model traffic chart and make it visually dominant.
- Add optional RGB mode as a local Router Stats appearance preference.
- Split the current single analytics page into focused page-level components.
- Keep the implementation compatible with the existing app shell and top navigation.

## Non-Goals

- No backend endpoint, database, or shared type changes.
- No server-synced UI preferences.
- No global app-wide neon redesign in this pass.
- No new permanent left navigation inside Router Stats.
- No animation of dense operational content such as tables or live event rows.

## Current Context

The frontend currently exposes one analytics page at `client/src/pages/AnalyticsPage.tsx`. It already fetches:

- `/api/analytics/summary`
- `/api/analytics/by-platform`
- `/api/analytics/model-timeline`
- `/api/analytics/by-model`
- `/api/analytics/error-distribution`
- `/api/analytics/errors`

The current app shell in `client/src/App.tsx` provides top navigation and constrains page content to `max-w-6xl`. The CSS token layer in `client/src/index.css` is mostly monochrome and already includes global chart variables, but those global chart tokens should not be replaced in v1.

## Route and Navigation

- Add canonical route `/router-stats`.
- Change the top nav label from `Analytics` to `Router Stats`.
- Point the nav item at `/router-stats`.
- Keep `/analytics` as a compatibility redirect to `/router-stats`.
- Keep existing auth, query client, and error boundary behavior unchanged.

Router Stats should opt into a wider route-level container, `max-w-7xl`, without changing the default shell width for the rest of the app.

## Visual System

Router Stats is the pilot surface for the neon visual system.

Add scoped classes:

- `.router-stats`
- `.router-stats.rgb-mode`

Add scoped CSS variables in `client/src/index.css`, for example:

- `--router-stat-bg`
- `--router-stat-panel`
- `--router-stat-border`
- `--router-stat-grid`
- `--router-stat-green`
- `--router-stat-cyan`
- `--router-stat-magenta`
- `--router-stat-yellow`
- `--router-stat-red`

Do not replace the global `--chart-*` variables in v1. Recharts can use a local TypeScript palette whose values are CSS variable strings:

```ts
const ROUTER_STATS_COLORS = {
  requests: "var(--router-stat-green)",
  latency: "var(--router-stat-cyan)",
  errors: "var(--router-stat-red)",
  series: [
    "var(--router-stat-green)",
    "var(--router-stat-cyan)",
    "var(--router-stat-magenta)",
    "var(--router-stat-yellow)",
  ],
} as const;
```

RGB mode:

- Store preference in `localStorage` key `routerStatsRgbMode`.
- Apply only within Router Stats using `.router-stats.rgb-mode`.
- Add subtle accent animation to panels, selected controls, or chart glow.
- Disable motion under `prefers-reduced-motion: reduce`.
- Do not animate `LiveEvents`, table rows, legends, or dense text.

## Page Layout

Use the existing top app navigation. Router Stats itself should be a wide, dense cockpit inside the main content area.

Desktop order:

1. Header row
   - title: `Router Stats`
   - short operational subtitle
   - range selector
   - RGB mode toggle
2. KPI strip
   - Requests
   - Success rate
   - Input tokens
   - Output tokens
   - Avg latency
3. Hero grid
   - `Traffic Mix Over Time`: stacked model usage chart, visually dominant
   - nested provider/model donut chart
4. Secondary charts
   - requests by provider
   - avg latency by provider
   - errors by provider
5. Operations section
   - live routing feed
   - `Model Leaderboard`
   - recent errors

Mobile order is the same priority order collapsed into one column.

## Data Derivations

All v1 data comes from existing queries.

### KPI Strip

Use `/api/analytics/summary`.

Keep the existing pinned request tooltip logic:

- pinned requests count requests where the client named a model.
- pin honored requests count pinned requests served by the requested model.
- failed-over pinned requests are `pinnedRequests - pinHonoredRequests`.

### Traffic Mix Over Time

Use `/api/analytics/model-timeline`.

Keep the existing stacked area model:

- use `series` to render one stacked area per model bucket.
- use `points` for time buckets.
- preserve the existing range-to-interval behavior.

Rename the panel from `Model usage over time` to `Traffic Mix Over Time`.

### Nested Provider/Model Donut

Use `/api/analytics/by-model`.

Derive:

- inner ring: aggregate `requests` by `platform`.
- outer ring: top model rows by `requests`.
- add an `Other` bucket when lower-volume model rows are hidden for readability.

The chart tooltip should show:

- provider or model label
- request count
- success rate when available

The full exact detail remains available in the Model Leaderboard table.

### Provider Charts

Use `/api/analytics/by-platform`.

Keep:

- requests by provider
- average latency by provider

Use `/api/analytics/error-distribution` for errors by provider.

### Model Leaderboard

Use `/api/analytics/by-model`.

Default order is requests descending. Keep success, latency, speed, pinned, and token totals visible. Visually emphasize:

- model
- provider
- requests
- success
- latency
- speed

Token columns remain available but quieter and farther right.

### Operations

Move `LiveEvents` below the hero and secondary chart sections. Keep it dense and non-animated.

Use `/api/analytics/errors` for recent errors.

## Components

Create `RouterStatsPage.tsx` as the canonical page module and move the analytics page implementation into that Router Stats shape. `AnalyticsPage.tsx` should no longer be the canonical route target after `/analytics` becomes a redirect. Split page internals into focused components. The exact file layout can remain local to the page unless reuse becomes necessary.

Suggested components:

- `RouterStatsPage`
- `MetricCard`
- `ChartPanel`
- `TimeRangeControl`
- `RgbModeToggle`
- `TrafficMixStack`
- `ModelMixDonut`
- `ProviderBars`
- `ModelLeaderboard`
- `ErrorPanels`

`RouterStatsPage` owns query calls, range state, RGB preference state, and derived chart data. Child components receive prepared data and visual settings.

## Empty and Error States

Keep simple operational empty states:

- `No routed traffic in this range`
- `No model mix yet`
- `No errors in this range`

Do not add onboarding or explanatory marketing copy.

Existing query error handling can stay consistent with the rest of the client. The app-level error boundary remains in place.

## Accessibility and Responsiveness

- RGB mode toggle must be a real button or switch with an accessible label.
- Charts should preserve readable tooltip text and legends.
- Color must not be the only signal for error/success states where text is shown.
- Mobile layout collapses to one column in the same priority order.
- Avoid viewport-scaled font sizes.
- Ensure long model names truncate cleanly without overlapping adjacent content.
- Disable RGB animations when the user prefers reduced motion.

## Testing and Verification

Run:

- `npm run test`
- `npm run build`

Manual verification:

- `/router-stats` renders the redesigned page.
- `/analytics` redirects to `/router-stats`.
- Time range selector changes all analytics queries.
- RGB mode persists after reload and only affects Router Stats.
- Empty data ranges show Router Stats-specific empty states.
- Nested donut matches the request totals from `byModel`.
- Model Leaderboard defaults to request count order.
- Mobile layout is one column and has no text or chart overlap.

## Risks and Mitigations

- Recharts color variables may behave differently across SVG attributes.
  - Use CSS variable strings in the TypeScript palette and verify in browser.
- A wider page could make other routes visually inconsistent.
  - Scope the wider container to Router Stats only.
- RGB mode could reduce operational readability.
  - Keep it optional, scoped, and limited to accents/glow.
- Breaking the current analytics route could affect bookmarks.
  - Keep `/analytics` as a redirect.

## Resolved Decisions

All v1 decisions are resolved:

- canonical route is `/router-stats`.
- `/analytics` redirects to `/router-stats`.
- RGB mode is local-only and Router Stats-scoped.
- nested donut derives from `byModel`.
- leaderboard defaults to requests descending.
- `LiveEvents` moves below the chart summary sections.
