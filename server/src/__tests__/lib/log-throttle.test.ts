import { describe, expect, test, vi } from 'vitest';
import { LogThrottle } from '../../lib/log-throttle.js';

describe('LogThrottle', () => {
  const now = 1_000_000_000_000; // Fixed timestamp for deterministic tests

  test('first event always emits', () => {
    const throttle = new LogThrottle();
    const evt = { type: 'heartbeat.ping', provider: 'openai', model: 'gpt-4', keyId: 1, success: true };
    const result = throttle.shouldEmit(evt, now);
    expect(result.emit).toBe(true);
    expect(result.suppressed).toBe(0);
  });

  test('duplicate within TTL is suppressed', () => {
    const throttle = new LogThrottle();
    const evt = { type: 'heartbeat.ping', provider: 'openai', model: 'gpt-4', keyId: 1, success: true };

    throttle.shouldEmit(evt, now); // First emission
    const result2 = throttle.shouldEmit(evt, now + 10_000); // 10s later, within 30s TTL
    expect(result2.emit).toBe(false);
    expect(result2.suppressed).toBe(0);
  });

  test('after TTL expires, suppressed count is reported', () => {
    const throttle = new LogThrottle();
    const evt = { type: 'heartbeat.ping', provider: 'openai', model: 'gpt-4', keyId: 1, success: true };

    throttle.shouldEmit(evt, now); // First emission
    throttle.shouldEmit(evt, now + 10_000); // Suppressed
    throttle.shouldEmit(evt, now + 20_000); // Suppressed

    // After TTL (30s) expired
    const result = throttle.shouldEmit(evt, now + 31_000);
    expect(result.emit).toBe(true);
    expect(result.suppressed).toBe(2); // Two were suppressed
  });

  test('different signatures are independent', () => {
    const throttle = new LogThrottle();
    const evt1 = { type: 'heartbeat.ping', provider: 'openai', model: 'gpt-4', keyId: 1, success: true };
    const evt2 = { type: 'heartbeat.ping', provider: 'openai', model: 'gpt-4', keyId: 2, success: true }; // Different keyId

    throttle.shouldEmit(evt1, now); // First for key 1
    throttle.shouldEmit(evt1, now + 10_000); // Suppressed for key 1

    const result2 = throttle.shouldEmit(evt2, now + 10_000); // First for key 2
    expect(result2.emit).toBe(true);
    expect(result2.suppressed).toBe(0);
  });

  test('fallback TTL for unknown event types', () => {
    const throttle = new LogThrottle();
    const evt = { type: 'unknown.event', foo: 'bar' };

    throttle.shouldEmit(evt, now); // First emission
    const result = throttle.shouldEmit(evt, now + 3_000); // Within 5s fallback TTL
    expect(result.emit).toBe(false);

    const result2 = throttle.shouldEmit(evt, now + 6_000); // After 5s fallback TTL
    expect(result2.emit).toBe(true);
    expect(result2.suppressed).toBe(1);
  });

  test('custom TTLs override defaults', () => {
    const throttle = new LogThrottle({
      'heartbeat.ping': 5_000, // Override to 5s instead of 30s
    });
    const evt = { type: 'heartbeat.ping', provider: 'openai', model: 'gpt-4', keyId: 1, success: true };

    throttle.shouldEmit(evt, now); // First emission
    const result = throttle.shouldEmit(evt, now + 3_000); // Within 5s custom TTL
    expect(result.emit).toBe(false);

    const result2 = throttle.shouldEmit(evt, now + 6_000); // After 5s custom TTL
    expect(result2.emit).toBe(true);
    expect(result2.suppressed).toBe(1);
  });

  test('signature excludes volatile fields', () => {
    const throttle = new LogThrottle();
    const evt1 = { type: 'heartbeat.ping', provider: 'openai', model: 'gpt-4', keyId: 1, success: true, at: 1000 };
    const evt2 = { type: 'heartbeat.ping', provider: 'openai', model: 'gpt-4', keyId: 1, success: true, at: 2000 }; // Different timestamp

    throttle.shouldEmit(evt1, now); // First emission
    const result = throttle.shouldEmit(evt2, now + 10_000); // Should be suppressed despite different 'at'
    expect(result.emit).toBe(false);
  });

  test('flush clears all state', () => {
    const throttle = new LogThrottle();
    const evt = { type: 'heartbeat.ping', provider: 'openai', model: 'gpt-4', keyId: 1, success: true };

    throttle.shouldEmit(evt, now); // First emission
    throttle.shouldEmit(evt, now + 10_000); // Suppressed

    throttle.flush();

    // After flush, should emit again as if first time
    const result = throttle.shouldEmit(evt, now + 20_000);
    expect(result.emit).toBe(true);
    expect(result.suppressed).toBe(0);
  });

  test('lazy eviction when map grows large', () => {
    const throttle = new LogThrottle();
    const baseEvent = { type: 'heartbeat.ping', provider: 'openai', model: 'gpt-4', success: true };

    // Fill the map beyond the 1000 threshold
    for (let i = 0; i < 1001; i++) {
      const evt = { ...baseEvent, keyId: i };
      throttle.shouldEmit(evt, now);
    }

    // After adding 1001 entries, the next call should trigger eviction of expired entries
    // Since all were added at the same time, none are expired yet, so size should still be >1000
    // But let's test that we can still add more
    const newEvent = { ...baseEvent, keyId: 9999 };
    const result = throttle.shouldEmit(newEvent, now);
    expect(result.emit).toBe(true); // Should still be able to add new entries
  });
});
