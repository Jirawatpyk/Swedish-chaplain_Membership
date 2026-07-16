import { describe, expect, it } from 'vitest';
import { deriveMembershipAccess, type RenewalCycle } from '@/modules/renewals';

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const NOW = new Date('2026-07-13T00:00:00.000Z');

/** Build a RenewalCycle fixture (mirrors tests/unit/renewals/domain/is-membership-lapsed.test.ts). */
function cycle(over: Partial<RenewalCycle>): RenewalCycle {
  return {
    tenantId: 't1',
    cycleId: '00000000-0000-0000-0000-000000000001',
    memberId: '00000000-0000-0000-0000-0000000000aa',
    status: 'upcoming',
    periodFrom: PAST,
    periodTo: FUTURE,
    expiresAt: FUTURE,
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular',
    planIdAtCycleStart: '00000000-0000-0000-0000-0000000000bb',
    frozenPlanPriceThb: '1000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    linkedCreditNoteId: null,
    linkedInvoiceId: null,
    anchoredAt: null,
    anchorInvoiceId: null,
    createdAt: PAST,
    updatedAt: PAST,
    closedAt: null,
    closedReason: null,
    enteredPendingAt: null,
    ...over,
  } as RenewalCycle;
}

describe('deriveMembershipAccess', () => {
  it.each([
    ['upcoming, future expiry',       { status: 'upcoming', expiresAt: FUTURE },              'full',       'in_good_standing'],
    ['reminded, future expiry',       { status: 'reminded', expiresAt: FUTURE },              'full',       'in_good_standing'],
    ['upcoming, PAST expiry (cron gap)', { status: 'upcoming', expiresAt: PAST },             'suspended',  'unpaid'],
    ['reminded, PAST expiry',         { status: 'reminded', expiresAt: PAST },                'suspended',  'unpaid'],
    ['awaiting_payment',              { status: 'awaiting_payment', expiresAt: PAST },        'suspended',  'unpaid'],
    ['pending_admin_reactivation',    { status: 'pending_admin_reactivation', expiresAt: PAST, enteredPendingAt: PAST }, 'suspended', 'pending_review'],
    ['completed, PAST expiry',        { status: 'completed', expiresAt: PAST, closedAt: PAST, closedReason: 'paid', linkedInvoiceId: 'inv1' }, 'full', 'in_good_standing'],
    ['completed, future expiry',      { status: 'completed', expiresAt: FUTURE, closedAt: PAST, closedReason: 'paid', linkedInvoiceId: 'inv1' }, 'full', 'in_good_standing'],
    ['lapsed, past expiry',           { status: 'lapsed', expiresAt: PAST, closedAt: PAST, closedReason: 'lapsed' }, 'terminated', 'grace_expired'],
    // 065 §5.2⇄§5.3 — a `lapsed` cycle is terminated REGARDLESS of expiry: a
    // born-`awaiting_payment` new member lapsed at due+60 carries a far-future
    // `expiresAt = period_to` but has never paid, so they must lose access
    // (the old `expiresAt < now` gate would have wrongly resolved this `full`).
    ['lapsed, FUTURE expiry (065 born-awaiting)', { status: 'lapsed', expiresAt: FUTURE, closedAt: PAST, closedReason: 'lapsed' }, 'terminated', 'grace_expired'],
    ['cancelled, PAST expiry',        { status: 'cancelled', expiresAt: PAST, closedAt: PAST, closedReason: 'cancelled' }, 'terminated', 'cancelled'],
    ['cancelled, FUTURE expiry',      { status: 'cancelled', expiresAt: FUTURE, closedAt: PAST, closedReason: 'cancelled' }, 'full', 'in_good_standing'],
  ] as const)('%s', (_label, over, access, reason) => {
    const d = deriveMembershipAccess(cycle(over), NOW);
    expect(d.access).toBe(access);
    expect(d.reason).toBe(reason);
  });

  it('null cycle → full', () => {
    expect(deriveMembershipAccess(null, NOW)).toEqual({ access: 'full', reason: 'in_good_standing' });
  });

  it('expiresAt exactly === now → still full (strict <)', () => {
    expect(deriveMembershipAccess(cycle({ status: 'upcoming', expiresAt: NOW.toISOString() }), NOW).access).toBe('full');
  });

  it('malformed expiresAt on a terminal cycle → terminated', () => {
    expect(
      deriveMembershipAccess(
        cycle({ status: 'lapsed', expiresAt: 'not-a-date', closedAt: PAST, closedReason: 'lapsed' }),
        NOW,
      ).access,
    ).toBe('terminated');
  });
});
