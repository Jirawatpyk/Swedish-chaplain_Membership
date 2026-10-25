/**
 * 128 (#650 review) — the in-memory fallback must not grow without bound.
 *
 * During a long Upstash slowdown every distinct key (`signin:email:<x>`,
 * `signin:ip:<y>` …) lands in the fallback map. Before 128 nothing ever
 * removed an entry, so a spray of distinct keys grew the instance's heap
 * for its whole lifetime. Expired buckets are now swept.
 */
import { describe, expect, it } from 'vitest';
import { createFallbackBuckets } from '@/modules/auth/infrastructure/rate-limit/fallback-buckets';

describe('createFallbackBuckets (128)', () => {
  it('enforces max within a window and resets after it', () => {
    const b = createFallbackBuckets();
    const t0 = 1_000_000;
    expect(b.check('k', 2, 60, t0).success).toBe(true);
    expect(b.check('k', 2, 60, t0 + 1).success).toBe(true);
    expect(b.check('k', 2, 60, t0 + 2).success).toBe(false);
    expect(b.check('k', 2, 60, t0 + 60_000).success).toBe(true);
  });

  it('drops expired buckets so distinct keys do not pile up', () => {
    const b = createFallbackBuckets();
    const t0 = 1_000_000;
    for (let i = 0; i < 500; i += 1) b.check(`signin:email:${i}`, 5, 60, t0);
    expect(b.size()).toBe(500);
    // Two minutes later every 60 s window has expired.
    b.check('signin:email:new', 5, 60, t0 + 120_000);
    expect(b.size()).toBe(1);
  });

  it('keeps a bucket whose window is still open', () => {
    const b = createFallbackBuckets();
    const t0 = 1_000_000;
    b.check('long', 1, 3600, t0);
    b.check('short', 1, 60, t0);
    b.check('other', 1, 60, t0 + 120_000);
    expect(b.check('long', 1, 3600, t0 + 120_001).success).toBe(false);
    expect(b.size()).toBe(2);
  });
});
