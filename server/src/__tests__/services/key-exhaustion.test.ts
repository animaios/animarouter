import { describe, expect, it } from 'vitest';
import { initDb } from '../../db/index.js';
import { markExhausted, sweepStaleExhaustion } from '../../services/key-exhaustion.js';
import { getNextCooldownDuration } from '../../services/ratelimit.js';

describe('Key exhaustion sweep', () => {
  it('does not clear daily cooldown escalation history when sweeping stale exhaustion', () => {
    initDb(':memory:');
    const keyId = Math.floor(Math.random() * 1_000_000);
    const provider = 'openrouter';
    const modelId = `daily-quota-${keyId}`;

    expect(getNextCooldownDuration(provider, modelId, keyId)).toBe(2 * 60 * 1000);
    expect(getNextCooldownDuration(provider, modelId, keyId)).toBe(10 * 60 * 1000);

    markExhausted(keyId, provider, modelId);

    expect(sweepStaleExhaustion()).toBe(1);
    expect(getNextCooldownDuration(provider, modelId, keyId)).toBe(60 * 60 * 1000);
  });
});
