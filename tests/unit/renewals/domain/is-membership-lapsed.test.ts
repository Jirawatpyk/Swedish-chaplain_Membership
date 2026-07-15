import { describe, expect, it } from 'vitest';
import { isMembershipLapsed, type RenewalCycle } from '@/modules/renewals';

const NOW = new Date('2026-06-06T00:00:00.000Z');
const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2027-01-01T00:00:00.000Z';

/** Build a RenewalCycle fixture (mirrors tests/unit/portal/dashboard/dashboard-stats.test.ts). */
function cycle(overrides: Partial<RenewalCycle>): RenewalCycle {
  return {
    tenantId: 't',
    cycleId: 'c1',
    memberId: 'm1',
    status: 'awaiting_payment',
    periodFrom: '2026-01-01T00:00:00.000Z',
    periodTo: FUTURE,
    expiresAt: FUTURE,
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular',
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    linkedCreditNoteId: null,
    anchoredAt: null,
    anchorInvoiceId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    closedReason: null,
    linkedInvoiceId: null,
    enteredPendingAt: null,
    ...overrides,
  } as RenewalCycle;
}

describe('isMembershipLapsed', () => {
  it('true: terminal lapsed cycle past expiry', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: PAST }),
        NOW,
      ),
    ).toBe(true);
  });

  it('true: terminal cancelled cycle past expiry', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'cancelled', closedAt: PAST, closedReason: 'cancelled', expiresAt: PAST }),
        NOW,
      ),
    ).toBe(true);
  });

  it('true: ended-terminal cycle with an UNPARSEABLE expiresAt', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: 'not-a-date' }),
        NOW,
      ),
    ).toBe(true);
  });

  it('false: completed cycle (paid/renewed — good standing) even past expiry', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'completed', closedAt: PAST, closedReason: 'paid', linkedInvoiceId: 'inv1', expiresAt: PAST }),
        NOW,
      ),
    ).toBe(false);
  });

  it('false: non-terminal active cycle (future expiry)', () => {
    expect(isMembershipLapsed(cycle({ status: 'awaiting_payment', expiresAt: FUTURE }), NOW)).toBe(false);
  });

  it('false: non-terminal cycle PAST expiry (overdue/grace — NOT lapsed)', () => {
    expect(isMembershipLapsed(cycle({ status: 'awaiting_payment', expiresAt: PAST }), NOW)).toBe(false);
  });

  // 065 §5.2⇄§5.3 — a `lapsed` cycle is lapsed REGARDLESS of expiry. This
  // WAS `false` ("coverage still live") on the assumption that a lapsed
  // cycle always had a past `expiresAt`; §5.3's born-`awaiting_payment` new
  // member (initial cycle carries a far-future `expiresAt = period_to`)
  // lapsed at due+60 breaks that assumption. A lapsed non-payer has no paid
  // coverage to preserve, so they are lapsed.
  it('true: terminal lapsed cycle whose expiresAt is in the FUTURE (065 born-awaiting)', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: FUTURE }),
        NOW,
      ),
    ).toBe(true);
  });

  it('false: terminal CANCELLED cycle whose expiresAt is in the FUTURE (coverage still live)', () => {
    // `cancelled` KEEPS the expiry check (it can befall a PAID cycle via the
    // archive cascade whose coverage is legitimately still live) — this is
    // the case the old lapsed test used to encode.
    expect(
      isMembershipLapsed(
        cycle({ status: 'cancelled', closedAt: PAST, closedReason: 'cancelled', expiresAt: FUTURE }),
        NOW,
      ),
    ).toBe(false);
  });

  it('false: pending_admin_reactivation (non-terminal)', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'pending_admin_reactivation', enteredPendingAt: PAST, expiresAt: PAST }),
        NOW,
      ),
    ).toBe(false);
  });

  it('false: CANCELLED cycle with expiresAt EXACTLY == now (strict <, not ≤)', () => {
    // The strict-`<` expiry boundary still governs `cancelled` (065 §5.2⇄§5.3
    // moved `lapsed` off the expiry gate, so the boundary is exercised here).
    expect(
      isMembershipLapsed(
        cycle({ status: 'cancelled', closedAt: PAST, closedReason: 'cancelled', expiresAt: NOW.toISOString() }),
        NOW,
      ),
    ).toBe(false);
  });
});
