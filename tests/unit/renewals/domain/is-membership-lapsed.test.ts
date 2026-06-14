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

  it('false: terminal lapsed cycle whose expiresAt is in the FUTURE (coverage still live)', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: FUTURE }),
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

  it('false: expiresAt EXACTLY == now (strict <, not ≤)', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: NOW.toISOString() }),
        NOW,
      ),
    ).toBe(false);
  });
});
