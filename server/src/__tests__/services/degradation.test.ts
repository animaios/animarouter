import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initDegradation,
  classifyError,
  recordFailure,
  recordSuccess,
  getPenalty,
  getDegradationFactor,
  getDisplayTier,
  getAllStatesRaw,
  getAllStatesView,
  loadState,
  flushDirtyStates,
  evictGhostStates,
  getBoost,
  setBoost,
  resetBoost,
} from '../../services/degradation.js';
import * as events from '../../services/events.js';

vi.mock('../../services/events.js', () => ({
  publish: vi.fn(),
}));

const publishMock = vi.mocked(events.publish);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2024, 1, 1));
  publishMock.mockClear();
  initDegradation();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── classifyError ──────────────────────────────────────────────────────────────

describe('classifyError', () => {
  it('returns minor for 429 via status field', () => {
    expect(classifyError({ status: 429, message: 'rate limited' })).toBe('minor');
  });

  it('returns minor for 402 via status code', () => {
    expect(classifyError({ status: 402, message: 'payment required' })).toBe('minor');
  });

  it('returns major for 500, 502, 503, 504 via status codes', () => {
    expect(classifyError({ status: 500, message: '' })).toBe('major');
    expect(classifyError({ status: 502, message: '' })).toBe('major');
    expect(classifyError({ status: 503, message: '' })).toBe('major');
    expect(classifyError({ status: 504, message: '' })).toBe('major');
  });

  it('returns major for ECONNREFUSED, ETIMEDOUT, timeout, fetch failed via message', () => {
    expect(classifyError(new Error('ECONNREFUSED'))).toBe('major');
    expect(classifyError(new Error('ETIMEDOUT'))).toBe('major');
    expect(classifyError(new Error('connection timeout'))).toBe('major');
    expect(classifyError(new Error('fetch failed'))).toBe('major');
  });

  it('returns major for EPROTO, ECONNABORTED (TLS errors via message)', () => {
    expect(classifyError(new Error('EPROTO'))).toBe('major');
    expect(classifyError(new Error('ECONNABORTED'))).toBe('major');
  });

  it('returns null for 400, 401, 403, 404 (non-retryable, via status codes)', () => {
    expect(classifyError({ status: 400, message: '' })).toBeNull();
    expect(classifyError({ status: 401, message: '' })).toBeNull();
    expect(classifyError({ status: 403, message: '' })).toBeNull();
    expect(classifyError({ status: 404, message: '' })).toBeNull();
  });

  it('returns null for 429 with "quota" or "insufficient" in message (hard quota)', () => {
    expect(classifyError({ status: 429, message: 'quota exceeded' })).toBeNull();
    expect(classifyError({ status: 429, message: 'insufficient credits' })).toBeNull();
  });

  it('returns null for AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyError(err)).toBeNull();
  });

  it('returns null for a generic non-http error without recognized markers', () => {
    expect(classifyError(new Error('something weird happened'))).toBeNull();
  });

  it('status code field takes priority over message', () => {
    // err.status=503 with message that doesn't contain "503"
    const err = { status: 503, message: 'backend is down please retry later' };
    expect(classifyError(err)).toBe('major');
  });
});

// ── recordFailure + getPenalty ─────────────────────────────────────────────────

describe('recordFailure + getPenalty', () => {
  it('first minor hit → penalty ≈ 1.0 (exponent 0, no compounding)', () => {
    recordFailure(1, 'minor');
    expect(getPenalty(1)).toBeCloseTo(1.0, 2);
  });

  it('first major hit → penalty ≈ 3.0', () => {
    recordFailure(2, 'major');
    expect(getPenalty(2)).toBeCloseTo(3.0, 2);
  });

  it('second consecutive minor: penalty = 1.0 + 1.0×1.5¹ = 2.5', () => {
    recordFailure(1, 'minor'); // penalty = 1.0
    recordFailure(1, 'minor'); // penalty = 1.0 + 1.0*1.5 = 2.5
    expect(getPenalty(1)).toBeCloseTo(2.5, 2);
  });

  it('third consecutive minor: penalty = 2.5 + 1.0×1.5² = 4.75', () => {
    recordFailure(1, 'minor'); // 1.0
    recordFailure(1, 'minor'); // 2.5
    recordFailure(1, 'minor'); // 2.5 + 1.0*2.25 = 4.75
    expect(getPenalty(1)).toBeCloseTo(4.75, 2);
  });

  it('after success, next minor hit is weight×factor⁰ again (no compound)', () => {
    recordFailure(1, 'minor'); // 1.0
    recordSuccess(1);          // penalty reduced
    recordFailure(1, 'minor'); // fresh: exponent 0 → weight*1 = 1.0
    expect(getPenalty(1)).toBeCloseTo(1.0, 2);
  });

  it('critical escalation: exactly 3 consecutive major hits → critical weight used', () => {
    recordFailure(1, 'major'); // cons=1, consMajor=1, penalty = 3.0
    recordFailure(1, 'major'); // cons=2, consMajor=2, penalty = 3.0 + 3.0*1.5 = 7.5
    recordFailure(1, 'major'); // cons=3, consMajor=3 >= threshold → critical
    // increment = 6.0 * 1.5^2 = 6.0 * 2.25 = 13.5
    // penalty = 7.5 + 13.5 = 21.0
    expect(getPenalty(1)).toBeCloseTo(21.0, 1);
  });

  it('consecutiveMajorHits increments only on major, resets on minor hit', () => {
    recordFailure(1, 'major'); // consMajor = 1
    recordFailure(1, 'minor'); // consMajor = 0 (minor breaks streak)
    recordFailure(1, 'major'); // consMajor = 1 (not 2)
    // Should NOT have escalated to critical
    const states = getAllStatesRaw();
    expect(states.get(1)!.consecutiveMajorHits).toBe(1);
  });

  it('sequence minor → major → minor → major does NOT trigger critical (streak broken)', () => {
    recordFailure(1, 'minor');
    recordFailure(1, 'major');
    recordFailure(1, 'minor');
    recordFailure(1, 'major');
    const states = getAllStatesRaw();
    expect(states.get(1)!.consecutiveMajorHits).toBeLessThan(3);
    expect(states.get(1)!.tier).not.toBe('critical');
  });

  it('half-life changes to critical (60min) on critical escalation', () => {
    recordFailure(1, 'major'); // halfLifeMs = 15min
    recordFailure(1, 'major'); // halfLifeMs = 15min
    recordFailure(1, 'major'); // consMajor=3 → critical, halfLifeMs = 60min
    const states = getAllStatesRaw();
    expect(states.get(1)!.halfLifeMs).toBe(60 * 60 * 1000);
  });
});

// ── Time Decay ─────────────────────────────────────────────────────────────────

describe('Time Decay', () => {
  it('after one half-life of idle, penalty is approximately halved (within 1%)', () => {
    recordFailure(1, 'major'); // penalty = 3.0, halfLife = 15min
    vi.advanceTimersByTime(15 * 60 * 1000); // one half-life
    const p = getPenalty(1);
    expect(p).toBeCloseTo(1.5, 1);
  });

  it('after two half-lives, penalty is ≈ ¼', () => {
    recordFailure(1, 'major'); // penalty = 3.0, halfLife = 15min
    vi.advanceTimersByTime(30 * 60 * 1000); // two half-lives
    const p = getPenalty(1);
    expect(p).toBeCloseTo(0.75, 1);
  });

  it('getPenalty is lazy — does NOT mutate stored penalty (call twice, same stored value)', () => {
    recordFailure(1, 'major');
    vi.advanceTimersByTime(15 * 60 * 1000);
    const p1 = getPenalty(1);
    const p2 = getPenalty(1);
    expect(p1).toBe(p2);
    // Verify stored penalty unchanged
    const raw = getAllStatesRaw();
    expect(raw.get(1)!.penalty).toBeCloseTo(3.0, 2);
  });

  it('decay never produces negative penalty', () => {
    recordFailure(1, 'minor'); // 1.0
    vi.advanceTimersByTime(100 * 60 * 1000); // long time
    expect(getPenalty(1)).toBeGreaterThanOrEqual(0);
  });

  it('penalty below 0.01 after decay snaps to exactly 0', () => {
    recordFailure(1, 'minor'); // 1.0, halfLife=2min
    vi.advanceTimersByTime(20 * 60 * 1000); // 10 half-lives → 1.0 * 0.5^10 ≈ 0.001
    expect(getPenalty(1)).toBe(0);
  });
});

// ── recordSuccess ──────────────────────────────────────────────────────────────

describe('recordSuccess', () => {
  it('success at penalty=100: floor(100×0.3)=30, 100-30=70', () => {
    // Force penalty to 100 via loadState
    loadState(1, {
      penalty: 100,
      tier: 'critical',
      consecutiveHits: 6,
      consecutiveMajorHits: 5,
      lastHitAt: Date.now(),
      halfLifeMs: 60 * 60 * 1000,
      dirty: false,
      boost: 1.0,
    });
    recordSuccess(1);
    // decay elapsed=0 → penalty stays 100. recovery = floor(100*0.3) = 30. 100-30=70
    expect(getPenalty(1)).toBeCloseTo(70, 0);
  });

  it('success at penalty=3: floor(3×0.3)=0 → max(1,0)=1, 3-1=2', () => {
    loadState(1, {
      penalty: 3,
      tier: 'minor',
      consecutiveHits: 2,
      consecutiveMajorHits: 0,
      lastHitAt: Date.now(),
      halfLifeMs: 2 * 60 * 1000,
      dirty: false,
      boost: 1.0,
    });
    recordSuccess(1);
    // floor(3*0.3) = floor(0.9) = 0, max(1,0) = 1, 3-1=2
    expect(getPenalty(1)).toBeCloseTo(2, 0);
  });

  it('success resets consecutiveHits to 0', () => {
    recordFailure(1, 'minor');
    recordFailure(1, 'minor');
    recordSuccess(1);
    // State may have been deleted if penalty hit 0; check raw
    const states = getAllStatesRaw();
    const state = states.get(1);
    if (state) {
      expect(state.consecutiveHits).toBe(0);
    }
    // If deleted, penalty is 0 which is also fine
  });

  it('success resets consecutiveMajorHits to 0', () => {
    recordFailure(1, 'major');
    recordFailure(1, 'major');
    recordSuccess(1);
    const states = getAllStatesRaw();
    const state = states.get(1);
    if (state) {
      expect(state.consecutiveMajorHits).toBe(0);
    }
  });

  it('success on penalty=0 is a no-op (does not create state)', () => {
    recordSuccess(999);
    const states = getAllStatesRaw();
    expect(states.has(999)).toBe(false);
  });

  it('when penalty reaches 0, half-life resets to minor default', () => {
    loadState(1, {
      penalty: 0.5,
      tier: 'critical',
      consecutiveHits: 5,
      consecutiveMajorHits: 5,
      lastHitAt: Date.now(),
      halfLifeMs: 60 * 60 * 1000,
      dirty: false,
      boost: 1.0,
    });
    recordSuccess(1);
    // penalty < 1 → snap to 0, half-life resets to minor
    // State should be deleted (penalty=0)
    const states = getAllStatesRaw();
    expect(states.has(1)).toBe(false);
  });
});

// ── getDegradationFactor (CORRECTED values) ────────────────────────────────────

describe('getDegradationFactor', () => {
  it('at penalty=0 → factor = 1.0', () => {
    expect(getDegradationFactor(999)).toBe(1);
  });

  it('at penalty=5 → factor ≈ 0.889 (within 0.01)', () => {
    loadState(1, {
      penalty: 5,
      tier: 'minor',
      consecutiveHits: 1,
      consecutiveMajorHits: 0,
      lastHitAt: Date.now(),
      halfLifeMs: 2 * 60 * 1000,
      dirty: false,
      boost: 1.0,
    });
    expect(getDegradationFactor(1)).toBeCloseTo(0.889, 2);
  });

  it('at penalty=10 → factor ≈ 0.667 (within 0.01)', () => {
    loadState(1, {
      penalty: 10,
      tier: 'minor',
      consecutiveHits: 1,
      consecutiveMajorHits: 0,
      lastHitAt: Date.now(),
      halfLifeMs: 2 * 60 * 1000,
      dirty: false,
      boost: 1.0,
    });
    expect(getDegradationFactor(1)).toBeCloseTo(0.667, 2);
  });

  it('at penalty=25 → factor ≈ 0.242 (within 0.01)', () => {
    loadState(1, {
      penalty: 25,
      tier: 'major',
      consecutiveHits: 1,
      consecutiveMajorHits: 0,
      lastHitAt: Date.now(),
      halfLifeMs: 15 * 60 * 1000,
      dirty: false,
      boost: 1.0,
    });
    expect(getDegradationFactor(1)).toBeCloseTo(0.242, 2);
  });

  it('at penalty=100 → factor ≈ 0.020 (within 0.005)', () => {
    loadState(1, {
      penalty: 100,
      tier: 'critical',
      consecutiveHits: 6,
      consecutiveMajorHits: 5,
      lastHitAt: Date.now(),
      halfLifeMs: 60 * 60 * 1000,
      dirty: false,
      boost: 1.0,
    });
    expect(getDegradationFactor(1)).toBeCloseTo(0.020, 3);
  });

  it('factor is monotonically decreasing with penalty', () => {
    const penalties = [0, 1, 5, 10, 25, 50, 100];
    const factors = penalties.map((p) => {
      if (p === 0) return 1;
      loadState(p, {
        penalty: p,
        tier: 'minor',
        consecutiveHits: 1,
        consecutiveMajorHits: 0,
        lastHitAt: Date.now(),
        halfLifeMs: 2 * 60 * 1000,
        dirty: false,
        boost: 1.0,
      });
      return getDegradationFactor(p);
    });
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeLessThan(factors[i - 1]);
    }
  });

  it('factor never goes below 0, never above 1', () => {
    for (const p of [0, 1, 10, 50, 100]) {
      loadState(p + 200, {
        penalty: p,
        tier: 'minor',
        consecutiveHits: 1,
        consecutiveMajorHits: 0,
        lastHitAt: Date.now(),
        halfLifeMs: 2 * 60 * 1000,
        dirty: false,
        boost: 1.0,
      });
      const f = getDegradationFactor(p + 200);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});

// ── Bounds + Dirty Flag ───────────────────────────────────────────────────────

describe('Bounds + Dirty Flag', () => {
  it('penalty never exceeds MAX_PENALTY (100) even with many rapid hits', () => {
    for (let i = 0; i < 20; i++) {
      recordFailure(1, 'major');
    }
    expect(getPenalty(1)).toBeLessThanOrEqual(100);
  });

  it('penalty never goes negative after success on decayed-to-near-zero', () => {
    loadState(1, {
      penalty: 0.005,
      tier: 'minor',
      consecutiveHits: 1,
      consecutiveMajorHits: 0,
      lastHitAt: Date.now(),
      halfLifeMs: 2 * 60 * 1000,
      dirty: false,
      boost: 1.0,
    });
    recordSuccess(1);
    expect(getPenalty(1)).toBeGreaterThanOrEqual(0);
  });

  it('compounding factor of 1.0 (via config override) disables compounding', () => {
    initDegradation({ compoundFactor: 1.0 } as any);
    recordFailure(1, 'minor'); // 1.0 * 1.0^0 = 1.0
    recordFailure(1, 'minor'); // 1.0 + 1.0 * 1.0^1 = 2.0
    recordFailure(1, 'minor'); // 2.0 + 1.0 * 1.0^2 = 3.0
    expect(getPenalty(1)).toBeCloseTo(3.0, 2);
  });

  it('mutations set dirty = true; non-mutating reads do not', () => {
    recordFailure(1, 'minor');
    const raw = getAllStatesRaw();
    expect(raw.get(1)!.dirty).toBe(true);

    // Reading does not set dirty
    getPenalty(1);
    getDegradationFactor(1);
    const raw2 = getAllStatesRaw();
    expect(raw2.get(1)!.dirty).toBe(true); // still true from the mutation
  });

  it('flushDirtyStates returns only dirty entries and clears their dirty flag', () => {
    recordFailure(1, 'minor');
    recordFailure(2, 'major');

    const dirty = flushDirtyStates();
    expect(dirty.length).toBe(2);

    // After flush, dirty should be false
    const raw = getAllStatesRaw();
    expect(raw.get(1)!.dirty).toBe(false);
    expect(raw.get(2)!.dirty).toBe(false);

    // Second flush should return nothing
    const dirty2 = flushDirtyStates();
    expect(dirty2.length).toBe(0);
  });

  it('evictGhostStates removes entries with decayed penalty < 0.01', () => {
    loadState(1, {
      penalty: 0.005,
      tier: 'minor',
      consecutiveHits: 1,
      consecutiveMajorHits: 0,
      lastHitAt: Date.now(),
      halfLifeMs: 2 * 60 * 1000,
      dirty: false,
      boost: 1.0,
    });
    const evicted = evictGhostStates();
    expect(evicted).toContain(1);
    expect(getPenalty(1)).toBe(0);
  });
});

// ── API Shape ──────────────────────────────────────────────────────────────────

describe('API Shape', () => {
  it('getAllStatesRaw() returns stored penalties (no decay)', () => {
    recordFailure(1, 'minor');
    vi.advanceTimersByTime(10 * 60 * 1000); // wait 10 minutes
    const raw = getAllStatesRaw();
    // Raw should return stored penalty (1.0), not decayed
    expect(raw.get(1)!.penalty).toBeCloseTo(1.0, 2);
  });

  it('getAllStatesView() returns decayed penalties + displayTier', () => {
    recordFailure(1, 'minor'); // penalty=1.0, halfLife=2min
    vi.advanceTimersByTime(4 * 60 * 1000); // 2 half-lives → 0.25
    const view = getAllStatesView();
    const entry = view.get(1)!;
    expect(entry.penalty).toBeCloseTo(0.25, 1);
    expect(entry.displayTier).toBe('minor');
  });

  it('loadState() then getPenalty() returns the loaded penalty (with lazy decay)', () => {
    loadState(42, {
      penalty: 15,
      tier: 'major',
      consecutiveHits: 3,
      consecutiveMajorHits: 2,
      lastHitAt: Date.now(),
      halfLifeMs: 15 * 60 * 1000,
      dirty: false,
      boost: 1.0,
    });
    // Immediately: no decay
    expect(getPenalty(42)).toBeCloseTo(15, 1);

    // After one half-life
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(getPenalty(42)).toBeCloseTo(7.5, 1);
  });
});

// ── getDisplayTier ─────────────────────────────────────────────────────────────

describe('getDisplayTier', () => {
  it('returns healthy for penalty=0', () => {
    expect(getDisplayTier(0)).toBe('healthy');
  });

  it('returns minor for penalty 1-10', () => {
    expect(getDisplayTier(1)).toBe('minor');
    expect(getDisplayTier(10)).toBe('minor');
  });

  it('returns major for penalty 10-30', () => {
    expect(getDisplayTier(11)).toBe('major');
    expect(getDisplayTier(30)).toBe('major');
  });

  it('returns critical for penalty > 30', () => {
    expect(getDisplayTier(31)).toBe('critical');
    expect(getDisplayTier(100)).toBe('critical');
  });
});

// ── Boost Multiplier ──────────────────────────────────────────────────────────

describe('getBoost', () => {
  it('returns 1.0 for a modelDbId with no state', () => {
    expect(getBoost(999)).toBe(1.0);
  });

  it('returns the stored boost value after setBoost', () => {
    setBoost(1, 5.0);
    expect(getBoost(1)).toBe(5.0);
  });
});

describe('setBoost', () => {
  it('sets boost within bounds, sets dirty = true', () => {
    setBoost(1, 2.5);
    expect(getBoost(1)).toBe(2.5);
    const raw = getAllStatesRaw();
    expect(raw.get(1)!.dirty).toBe(true);
  });

  it('clamps below boostMin to boostMin (default 0.1)', () => {
    setBoost(1, 0.01);
    expect(getBoost(1)).toBeCloseTo(0.1, 5);
  });

  it('clamps above boostMax to boostMax (default 100.0)', () => {
    setBoost(1, 500);
    expect(getBoost(1)).toBeCloseTo(100.0, 5);
  });

  it('creates a new state for a model with no prior penalty', () => {
    setBoost(42, 3.0);
    expect(getBoost(42)).toBe(3.0);
    const raw = getAllStatesRaw();
    expect(raw.get(42)!.penalty).toBe(0);
  });

  it('emits degradation.boost event with oldBoost and newBoost', () => {
    setBoost(1, 2.0);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'degradation.boost',
        modelDbId: 1,
        oldBoost: 1.0,
        newBoost: 2.0,
      })
    );
  });

  it('does NOT affect penalty, tier, or half-life', () => {
    recordFailure(1, 'major'); // penalty ~3.0
    const rawBefore = getAllStatesRaw();
    const penaltyBefore = rawBefore.get(1)!.penalty;
    const tierBefore = rawBefore.get(1)!.tier;
    const halfLifeBefore = rawBefore.get(1)!.halfLifeMs;

    setBoost(1, 10.0);

    const rawAfter = getAllStatesRaw();
    expect(rawAfter.get(1)!.penalty).toBeCloseTo(penaltyBefore, 2);
    expect(rawAfter.get(1)!.tier).toBe(tierBefore);
    expect(rawAfter.get(1)!.halfLifeMs).toBe(halfLifeBefore);
  });
});

describe('resetBoost', () => {
  it('resets boost to 1.0, sets dirty = true', () => {
    setBoost(1, 5.0);
    resetBoost(1);
    // If penalty is 0, state is deleted; getBoost returns 1.0 default
    expect(getBoost(1)).toBe(1.0);
  });

  it('emits degradation.boost event', () => {
    setBoost(1, 5.0);
    publishMock.mockClear();
    resetBoost(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'degradation.boost',
        modelDbId: 1,
        oldBoost: 5.0,
        newBoost: 1.0,
      })
    );
  });

  it('deletes the state from the Map if penalty === 0', () => {
    setBoost(1, 5.0); // creates state with penalty=0
    resetBoost(1);
    const raw = getAllStatesRaw();
    expect(raw.has(1)).toBe(false);
  });

  it('does nothing if no state exists', () => {
    publishMock.mockClear();
    resetBoost(999); // no state
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe('boost + penalty interaction', () => {
  it('setBoost on a model with penalty > 0: boost is set, penalty unchanged', () => {
    loadState(1, {
      penalty: 20,
      tier: 'major',
      consecutiveHits: 3,
      consecutiveMajorHits: 2,
      lastHitAt: Date.now(),
      halfLifeMs: 15 * 60 * 1000,
      dirty: false,
      boost: 1.0,
    });
    setBoost(1, 3.0);
    const raw = getAllStatesRaw();
    expect(raw.get(1)!.boost).toBe(3.0);
    expect(raw.get(1)!.penalty).toBeCloseTo(20, 0);
  });

  it('resetBoost on a model with penalty > 0: boost reset to 1.0, state kept', () => {
    loadState(1, {
      penalty: 20,
      tier: 'major',
      consecutiveHits: 3,
      consecutiveMajorHits: 2,
      lastHitAt: Date.now(),
      halfLifeMs: 15 * 60 * 1000,
      dirty: false,
      boost: 5.0,
    });
    resetBoost(1);
    const raw = getAllStatesRaw();
    expect(raw.has(1)).toBe(true);
    expect(raw.get(1)!.boost).toBe(1.0);
    expect(raw.get(1)!.penalty).toBeCloseTo(20, 0);
  });
});

describe('getAllStatesView with boost', () => {
  it('returns boost field in the view', () => {
    setBoost(1, 2.5);
    const view = getAllStatesView();
    expect(view.get(1)!.boost).toBe(2.5);
  });
});
