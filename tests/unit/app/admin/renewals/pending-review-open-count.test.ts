/**
 * UX-audit PR-B B5 — `countOpenPendingReviewCycles` excludes decided (async
 * reject-with-refund settling) cycles from the "Pending review" tab badge.
 *
 * The tab count must reflect cycles that still need an admin decision. A cycle
 * whose `rejectRefundInitiatedAt` is non-null has already been rejected (its
 * refund is settling) — the list renders it read-only, so it is NOT open work.
 */
import { describe, it, expect } from 'vitest';
import { countOpenPendingReviewCycles } from '@/app/(staff)/admin/renewals/_lib/pending-review-open-count';

describe('countOpenPendingReviewCycles — B5 count honesty', () => {
  it('counts only cycles with a null reject-refund marker', () => {
    const cycles = [
      { rejectRefundInitiatedAt: null }, // open
      { rejectRefundInitiatedAt: '2026-04-05T00:00:00.000Z' }, // settling — decided
      { rejectRefundInitiatedAt: null }, // open
      { rejectRefundInitiatedAt: '2026-04-06T10:00:00.000Z' }, // settling — decided
    ];
    expect(countOpenPendingReviewCycles(cycles)).toBe(2);
  });

  it('returns 0 when every cycle is refund-settling (badge must not show hollow work)', () => {
    const cycles = [
      { rejectRefundInitiatedAt: '2026-04-05T00:00:00.000Z' },
      { rejectRefundInitiatedAt: '2026-04-06T00:00:00.000Z' },
    ];
    expect(countOpenPendingReviewCycles(cycles)).toBe(0);
  });

  it('counts all when none are settling', () => {
    const cycles = [
      { rejectRefundInitiatedAt: null },
      { rejectRefundInitiatedAt: null },
      { rejectRefundInitiatedAt: null },
    ];
    expect(countOpenPendingReviewCycles(cycles)).toBe(3);
  });

  it('returns 0 for an empty list', () => {
    expect(countOpenPendingReviewCycles([])).toBe(0);
  });
});
