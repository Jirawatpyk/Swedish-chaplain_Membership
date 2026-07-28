/**
 * Task 5 — pure predicate test for the mark-paid-offline "offer" gate.
 *
 * `shouldOfferMarkPaid` decides whether the pipeline ROW ⋯ menu and the
 * cycle-detail page offer the "Mark paid" affordance at all — it mirrors
 * (never replaces) the route's own state-machine guard
 * (`/api/admin/renewals/[cycleId]/mark-paid-offline`), so the UI never
 * presents a control the API would reject with `cycle_not_payable`.
 */
import { describe, expect, it } from 'vitest';
import {
  PAYABLE_STATUSES,
  shouldOfferMarkPaid,
} from '@/app/(staff)/admin/renewals/_lib/mark-paid-gate';

describe('mark-paid gate', () => {
  it('offers mark-paid only for payable statuses (mirrors the route guard)', () => {
    expect(shouldOfferMarkPaid('upcoming')).toBe(true);
    expect(shouldOfferMarkPaid('awaiting_payment')).toBe(true);
  });

  it('never offers mark-paid for terminal / reminded / pending statuses', () => {
    for (const s of [
      'reminded',
      'completed',
      'lapsed',
      'cancelled',
      'pending_admin_reactivation',
    ] as const) {
      expect(shouldOfferMarkPaid(s)).toBe(false);
    }
  });

  it('PAYABLE_STATUSES has exactly the two the cycle-detail control uses', () => {
    expect([...PAYABLE_STATUSES].sort()).toEqual(['awaiting_payment', 'upcoming']);
  });
});
