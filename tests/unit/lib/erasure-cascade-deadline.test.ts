/**
 * Spec 140 s1 review round 2 (code-review #9) — the one rule both erasure
 * routes use for the broadcasts cascade's deadline: the route's own
 * `maxDuration`, less a fixed reserve for the row in progress (two bounded
 * 10 s Resend calls) and the steps after the cascade.
 */
import { describe, expect, it } from 'vitest';
import { ERASURE_CASCADE_RESERVE_MS, erasureCascadeDeadline } from '@/lib/erasure-cascade-deadline';

describe('erasureCascadeDeadline', () => {
  it('is the route start + maxDuration, less the reserve', () => {
    const start = Date.parse('2026-10-31T00:00:00Z');
    expect(erasureCascadeDeadline(start, 300)).toEqual(new Date(start + 300_000 - ERASURE_CASCADE_RESERVE_MS));
  });

  // Review round 3 (code-review #2) — the deadline is checked only BEFORE a
  // row, so the reserve must hold the row in progress (DELETE 10 s + GET 10 s
  // + its evidence tx) and every cascade after broadcasts + the response.
  it('reserves at least 60 s: one row (two bounded 10 s calls + evidence) and the later cascades', () => {
    expect(ERASURE_CASCADE_RESERVE_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('follows the route: a shorter maxDuration gives an earlier deadline', () => {
    const start = Date.parse('2026-10-31T00:00:00Z');
    expect(erasureCascadeDeadline(start, 120).getTime()).toBeLessThan(erasureCascadeDeadline(start, 300).getTime());
  });
});
