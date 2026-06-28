## Summary

Renames the "Rabbit" routing strategy to "Iterative Refinement" throughout the entire codebase. This is a naming-only change with no behavioral modifications.

## Changes

### Server
- **Strategy constant**: `ROUTING_STRATEGY_RABBIT` → `ROUTING_STRATEGY_ITERATIVE_REFINEMENT`
- **Settings keys**: `rabbit_enabled`, `oscillator_load_shed_threshold`, `oscillator_injection_selection` → `iterative_refinement_enabled`, `iterative_refinement_load_shed_threshold`, `iterative_refinement_injection_selection`
- **Service file**: `rabbit-shake.ts` → `iterative-refinement-shake.ts`
  - `executeOscillator` function preserved
  - `getRabbitOscillatorDecision` → `getIterativeRefinementDecision`
  - `isRabbitLoadShedActive` → `isIterativeRefinementLoadShedActive`
  - All internal references updated
- **Proxy integration**: Updated decision gate and result logging
- **Events**: `RabbitCandidate` → `IterativeRefinementCandidate`, all event type strings updated
- **Feature settings**: Registry keys updated

### Tests
- `rabbit-shake.test.ts` → `iterative-refinement-shake.test.ts`
- `proxy-rabbit.test.ts` → `proxy-iterative-refinement.test.ts`
- All assertions and mock data updated to new strategy value

### Client
- `FallbackPage.tsx`: `RoutingStrategy` type, `STRATEGIES` array label "Rabbit" → "Iterative Refinement"
- `SettingsPage.tsx`: Settings order and references updated
- `live-events.tsx`: Event type names and formatting updated

### Documentation
- `tasks.md`, `design.md`, `requirements.md`: All Rabbit references renamed

## Verification
- `grep -r "Rabbit\|rabbit" --include="*.ts" --include="*.tsx" --include="*.md"` returns no matches
- All renamed tests pass locally

## Breaking Changes
None - this is a pure rename. The strategy value in the database changes from "rabbit" to "iterative_refinement", but this is a new feature not yet released.