# API Key Affinity Bug - Root Cause Analysis & Fix

## Problem Summary
All conversation threads were routing to key 1 (index 0) instead of distributing across available keys based on session hash.

## Root Cause
**File:** `/home/vi/animarouter/server/src/services/router.ts`  
**Lines:** 679-680 (original)

### Issue 1: Hash-computed index never used
The key selection loop always started at index 0, completely ignoring the hash-computed `idx` value:

```typescript
// BUGGY CODE:
if (useKeyAffinity) {
  keyOrder = [...healthyKeys, ...unhealthyKeys];
  const hash = crypto.createHash('sha1').update(options!.stickySessionKey!).digest();
  const hashInt = hash.readUInt32BE(0);
  idx = hashInt % keyOrder.length;  // ← idx computed but never used!
} else {
  // ... round-robin logic
}

for (let attempt = 0; attempt < keyOrder.length; attempt++) {
  const key = keyOrder[attempt];  // ← Always starts at index 0
  // ...
}
```

### Issue 2: Empty/undefined session key handling
The code didn't check if `stickySessionKey` was valid before attempting to hash it, causing crashes with empty/undefined values.

### Issue 3: Round-robin variable scoping
The `rrIdx` variable was scoped inside the else block, making it inaccessible for the round-robin index increment later in the code.

## Evidence

### 1. Test Output Before Fix
```
[Proxy] Key affinity selected key 1 for session session-
[Proxy] Key affinity selected key 1 for session session-
[Proxy] Key affinity selected key 1 for session session-
```
All sessions mapped to key 1 regardless of hash.

### 2. Hash Distribution Verification
Manual verification confirmed different session keys produce different hash values:

```
Session: 'session-abc-123' -> hash: 4197745392 -> key index (mod 3): 0
Session: 'session-a'       -> hash: 3969875458 -> key index (mod 3): 1
Session: 'session-b'       -> hash: 2793654596 -> key index (mod 3): 2
Session: 'session-c'       -> hash: 1087863468 -> key index (mod 3): 0
```

Despite correct hash computation, all sessions selected key at index 0 because the loop ignored `idx`.

## The Fix

### Change 1: Use hash-computed index (Line 679-681)
```typescript
// BEFORE:
for (let attempt = 0; attempt < keyOrder.length; attempt++) {
  const key = keyOrder[attempt];

// AFTER:
for (let attempt = 0; attempt < keyOrder.length; attempt++) {
  const actualIdx = useKeyAffinity ? (idx + attempt) % keyOrder.length : attempt;
  const key = keyOrder[actualIdx];
```

This ensures:
- **Key affinity mode**: First attempt uses `keyOrder[idx]` (hash-selected), then wraps around
- **Round-robin mode**: Starts at 0 from pre-rotated array (preserves existing behavior)

### Change 2: Validate session key before enabling affinity (Line 626-627)
```typescript
// BEFORE:
const useKeyAffinity = keyAffinityEnabled || (providerStickyEnabled && options?.stickySessionKey);

// AFTER:
const useKeyAffinity = (keyAffinityEnabled || (providerStickyEnabled && options?.stickySessionKey)) 
  && options?.stickySessionKey; // Only use affinity if we have a valid session key
```

Prevents crashes and falls back to round-robin when session key is empty/undefined.

### Change 3: Fix round-robin variable scoping (Lines 661, 699)
```typescript
// BEFORE:
let keyOrder: KeyRow[];
let idx: number;
if (useKeyAffinity) {
  // ...
} else {
  const rrIdx = roundRobinIndex.get(rrKey) ?? 0;  // ← scoped in else block
  // ...
}
// Later:
roundRobinIndex.set(rrKey, idx + attempt + 1);  // ← rrIdx not accessible!

// AFTER:
let keyOrder: KeyRow[];
let idx: number;
let rrIdx = 0; // For round-robin increment tracking
if (useKeyAffinity) {
  // ...
} else {
  rrIdx = roundRobinIndex.get(rrKey) ?? 0;
  // ...
}
// Later:
roundRobinIndex.set(rrKey, rrIdx + attempt + 1);  // ← Now uses rrIdx correctly
```

## Verification Results

### After Fix - Test Output
```
[Proxy] Key affinity selected key 1 for session 1e153788
[Proxy] Key affinity selected key 2 for session 4dd922d2
[Proxy] Key affinity selected key 3 for session 9f91ad80
[Proxy] Key affinity selected key 2 for session e83a72d2
[Proxy] Key affinity selected key 1 for session b9e9df76
```
Sessions now distribute across all available keys.

### Distribution Test Results
```
Key 1: 3 sessions
Key 2: 1 sessions
Key 3: 3 sessions
Unique keys used: 3/3
✅ PASS: All keys used
```

### Test Suite Status
```
✓ src/__tests__/integration/key-affinity.test.ts (17 tests) - ALL PASSING
  ✓ Happy Path: Same Session → Same Key (2 tests)
  ✓ Happy Path: Different Sessions → Different Keys (2 tests)
  ✓ Happy Path: Disabled Mode → Round-Robin (2 tests)
  ✓ Edge Case: Exhausted Key Fallback (3 tests)
  ✓ Edge Case: Empty Session Key (2 tests)
  ✓ Edge Case: Single Key Available (1 test)
  ✓ Edge Case: Pin Mode with Affinity (1 test)
  ✓ Edge Case: Hash Distribution (1 test)
  ✓ Edge Case: Backward Compatibility (2 tests)
  ✓ Edge Case: Session Key Consistency (1 test)
```

## Impact Assessment

- **Severity:** High - Defeated the entire purpose of multiple API keys
- **Scope:** All requests with key affinity enabled (now the default since recent changes)
- **Performance:** Single key became a bottleneck; rate limits hit faster than necessary
- **Reliability:** No automatic load distribution across keys

## Files Modified

1. `/home/vi/animarouter/server/src/services/router.ts` (lines 626-627, 661, 679-681, 699)
   - Fix hash-based key selection
   - Add session key validation
   - Fix round-robin variable scoping

## Post-Fix Behavior

### Key Affinity Mode (Enabled)
- Same session key → Same API key (deterministic)
- Different session keys → Different API keys (distributed via hash % keyCount)
- Empty/undefined session key → Falls back to round-robin

### Round-Robin Mode (Disabled)
- Ignores session keys
- Rotates through available keys sequentially
- Preserves backward compatibility

### Fallback Behavior
- If hash-selected key is exhausted, tries next keys in sequence
- Wraps around: idx → idx+1 → idx+2 → ... → idx-1 (mod length)
- All keys attempted before giving up
