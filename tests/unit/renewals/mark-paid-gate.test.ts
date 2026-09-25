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
    expect(shouldOfferMarkPaid('upcoming', null)).toBe(true);
    expect(shouldOfferMarkPaid('awaiting_payment', null)).toBe(true);
  });

  // A payable-status cycle that already carries a live linked bill (e.g. an
  // `awaiting_payment` cycle after the member confirmed early) is refused by
  // the use-case with `membership_bill_already_exists` — mint-and-pay must
  // never be offered there; staff record the payment on that bill instead.
  it('never offers mark-paid when the cycle already has a live linked bill', () => {
    const invoiceId = '22222222-2222-2222-2222-222222222222';
    expect(shouldOfferMarkPaid('awaiting_payment', invoiceId)).toBe(false);
    expect(shouldOfferMarkPaid('upcoming', invoiceId)).toBe(false);
  });

  it('never offers mark-paid for terminal / reminded / pending statuses', () => {
    for (const s of [
      'reminded',
      'completed',
      'lapsed',
      'cancelled',
      'pending_admin_reactivation',
    ] as const) {
      expect(shouldOfferMarkPaid(s, null)).toBe(false);
    }
  });

  it('PAYABLE_STATUSES has exactly the two the cycle-detail control uses', () => {
    expect([...PAYABLE_STATUSES].sort()).toEqual(['awaiting_payment', 'upcoming']);
  });
});
