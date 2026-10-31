/**
 * Spec 140 s1 review round 2 (code-review #9) — the one rule both erasure
 * routes use for the broadcasts cascade's deadline: the route's own
 * `maxDuration`, less a fixed reserve for the row in progress (two bounded
 * 10 s Resend calls) and the steps after the cascade.
 */
import { describe, expect, it } from 'vitest';
import {
  ERASURE_CASCADE_RESERVE_MS,
  ERASURE_MEMBER_START_FLOOR_MS,
  erasureCascadeDeadline,
  erasureMemberStartCutoff,
} from '@/lib/erasure-cascade-deadline';

// Review round 4 (code-review #2) — round 3 aligned the reconcile member-start
// cutoff WITH the deadline, so a member started at 239 s got ~1 s and deferred
// every terminal row. The cutoff sits a floor before the deadline instead.
describe('erasureMemberStartCutoff', () => {
  const start = Date.parse('2026-10-31T00:00:00Z');

  it('the floor holds one row: a 10 s DELETE, a 10 s GET and the evidence tx', () => {
    expect(ERASURE_MEMBER_START_FLOOR_MS).toBeGreaterThanOrEqual(30_000);
  });

  // Review round 5 — the cutoff's arithmetic, against fixed numbers (the
  // route-level pin is the reconcile-erasures contract case at 220 s).
  it('the cutoff of a 300 s route is 210 s after the start', () => {
    const deadline = erasureCascadeDeadline(start, 300);
    expect(erasureMemberStartCutoff(deadline).getTime() - start).toBe(210_000);
  });
});

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
