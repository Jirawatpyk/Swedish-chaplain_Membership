/**
 * 108 PR-C T083/T085 (FR-041, FR-042; research R9, contract § 3) — the ONE
 * audience ceiling. `audienceCeiling(batchingEnabled)` is the single
 * definition every caller reads (resolver, submit, count, dispatch); 5,000
 * when the F7.1a US1 batching path is OFF, 50,000 when ON — the latter equals
 * the DB CHECK `broadcasts_estimated_recipient_cap (0..50000)` and
 * `MAX_RECIPIENT_COUNT`, which do not change.
 *
 * The split threshold (10,000) must sit BELOW the batching-ON ceiling, or an
 * audience of 5,001–10,000 would be accepted at submit and never reach the
 * batch path (the exact gap research R-C § 4 found with the old 5,000 hard
 * cap making the split path unreachable).
 */
import { describe, expect, it } from 'vitest';
import {
  audienceCeiling,
  SPLIT_THRESHOLD_RECIPIENTS,
} from '@/modules/broadcasts/domain/audience-ceiling';

describe('audienceCeiling (108 PR-C)', () => {
  it('is 5,000 when the batching path is OFF (the F7 MVP figure)', () => {
    expect(audienceCeiling(false)).toBe(5_000);
  });

  it('is 50,000 when the batching path is ON (= the DB CHECK upper bound)', () => {
    expect(audienceCeiling(true)).toBe(50_000);
  });

  it('the split threshold sits strictly below the batching-ON ceiling, so every accepted large audience can reach the batch path', () => {
    expect(SPLIT_THRESHOLD_RECIPIENTS).toBe(10_000);
    expect(SPLIT_THRESHOLD_RECIPIENTS).toBeLessThan(audienceCeiling(true));
    // …and above the OFF ceiling: with batching OFF nothing is ever split,
    // because nothing above 5,000 is ever accepted.
    expect(SPLIT_THRESHOLD_RECIPIENTS).toBeGreaterThan(audienceCeiling(false));
  });
});
