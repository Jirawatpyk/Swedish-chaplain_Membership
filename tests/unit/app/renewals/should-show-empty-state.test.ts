import { describe, it, expect } from 'vitest';
import { shouldShowRenewalsEmptyState } from '@/app/(staff)/admin/renewals/_lib/should-show-empty-state';

/**
 * Pins the renewals full-card empty-state predicate. The load-bearing case is
 * #1: under the renewals-by-month lens the pipeline must stay navigable even
 * when the 90-day urgency window is empty — the exact SweCham/TSCC situation
 * for most of the year (Jan-clustered renewals). Blanking the pipeline there
 * with `RenewalsEmptyState` defeats the feature's core click-a-bucket
 * interaction, so the month lens must count as an active filter.
 */
describe('shouldShowRenewalsEmptyState', () => {
  it('is false under the month lens even when everything else is empty (the bug fix)', () => {
    expect(
      shouldShowRenewalsEmptyState({
        monthLensActive: true,
        tierSelected: false,
        totalInWindow: 0,
        lapsedCount: 0,
      }),
    ).toBe(false);
  });

  it('is true when NO filter is active and there is nothing to show', () => {
    expect(
      shouldShowRenewalsEmptyState({
        monthLensActive: false,
        tierSelected: false,
        totalInWindow: 0,
        lapsedCount: 0,
      }),
    ).toBe(true);
  });

  it('is false when a tier filter is active (empty table body belongs in-table)', () => {
    expect(
      shouldShowRenewalsEmptyState({
        monthLensActive: false,
        tierSelected: true,
        totalInWindow: 0,
        lapsedCount: 0,
      }),
    ).toBe(false);
  });

  it('is false when there are renewals in the urgency window', () => {
    expect(
      shouldShowRenewalsEmptyState({
        monthLensActive: false,
        tierSelected: false,
        totalInWindow: 5,
        lapsedCount: 0,
      }),
    ).toBe(false);
  });

  it('is false when there are lapsed renewals', () => {
    expect(
      shouldShowRenewalsEmptyState({
        monthLensActive: false,
        tierSelected: false,
        totalInWindow: 0,
        lapsedCount: 3,
      }),
    ).toBe(false);
  });
});
