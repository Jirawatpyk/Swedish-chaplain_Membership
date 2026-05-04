/**
 * T034 spec — RenewalCycle aggregate invariants.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSED_REASONS,
  asCycleId,
  parseCycleId,
  assertCycleInvariants,
  cycleFrozenPriceSatang,
  isOverdue,
  daysUntilExpiry,
  type RenewalCycle,
} from '@/modules/renewals/domain/renewal-cycle';

const VALID_UUID = '00000000-0000-0000-0000-0000000000c1';

/**
 * Builds an active (`upcoming`) cycle. Override any field including
 * `status` to construct other variants. The cast is necessary because
 * the discriminated union can't infer the union arm from a partial
 * spread — production code uses status-aware factories instead, but
 * tests are trusted to pass coherent overrides.
 */
function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return {
    tenantId: 't',
    cycleId: asCycleId(VALID_UUID),
    memberId: 'm',
    status: 'upcoming' as const,
    periodFrom: '2026-06-01T00:00:00Z',
    periodTo: '2027-06-01T00:00:00Z',
    expiresAt: '2027-06-01T00:00:00Z',
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular' as const,
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB' as const,
    enteredPendingAt: null,
    linkedInvoiceId: null,
    linkedCreditNoteId: null,
    closedAt: null,
    closedReason: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  } as RenewalCycle;
}

describe('CycleId brand', () => {
  it('parseCycleId — accepts valid UUID', () => {
    const r = parseCycleId(VALID_UUID);
    expect(r.ok).toBe(true);
  });

  it('parseCycleId — rejects malformed', () => {
    for (const raw of ['not-a-uuid', '', '12345']) {
      const r = parseCycleId(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('invalid_cycle_id');
    }
  });

  it('parseCycleId — rejects non-string input', () => {
    const r = parseCycleId(42 as unknown as string);
    expect(r.ok).toBe(false);
  });

  it('asCycleId — unchecked cast', () => {
    expect(asCycleId('whatever')).toBe('whatever');
  });
});

describe('CLOSED_REASONS', () => {
  it('contains the 7 canonical reasons from data-model L46', () => {
    expect(CLOSED_REASONS).toEqual([
      'paid',
      'cancelled',
      'lapsed',
      'completed_offline',
      'admin_reactivated',
      'admin_rejected_with_refund',
      'pending_reactivation_timed_out',
    ]);
  });
});

describe('assertCycleInvariants', () => {
  it('happy path — `upcoming` cycle passes', () => {
    expect(assertCycleInvariants(buildCycle()).ok).toBe(true);
  });

  it('rejects period_to ≤ period_from', () => {
    const r = assertCycleInvariants(
      buildCycle({
        periodFrom: '2027-06-01T00:00:00Z',
        periodTo: '2026-06-01T00:00:00Z',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('period_order_violation');
  });

  it('rejects cycle_length_months out of (0, 60] range', () => {
    expect(
      assertCycleInvariants(buildCycle({ cycleLengthMonths: 0 })).ok,
    ).toBe(false);
    expect(
      assertCycleInvariants(buildCycle({ cycleLengthMonths: 61 })).ok,
    ).toBe(false);
  });

  it('rejects negative or non-finite frozen price', () => {
    expect(
      assertCycleInvariants(buildCycle({ frozenPlanPriceThb: '-1.00' })).ok,
    ).toBe(false);
    expect(
      assertCycleInvariants(buildCycle({ frozenPlanPriceThb: 'not a number' }))
        .ok,
    ).toBe(false);
  });

  it('rejects frozen_term_months out of (0, 60] range', () => {
    expect(
      assertCycleInvariants(buildCycle({ frozenPlanTermMonths: 0 })).ok,
    ).toBe(false);
    expect(
      assertCycleInvariants(buildCycle({ frozenPlanTermMonths: 61 })).ok,
    ).toBe(false);
  });

  // The 5 status-conditional invariants previously asserted at runtime
  // (`completed_requires_invoice`, `closed_at_terminal_mismatch` ×2,
  // `pending_at_status_mismatch` ×2) are now enforced at COMPILE TIME
  // by the RenewalCycle discriminated union — illegal combinations
  // become TypeScript errors instead of runtime Result.err. The
  // following tests document each rejected combination via
  // `@ts-expect-error` so the type-system contract is locked in.

  it('compile-error: completed without linkedInvoiceId', () => {
    // @ts-expect-error — completed cycles require linkedInvoiceId: string
    const _illegal: RenewalCycle = {
      ...buildCycle(),
      status: 'completed',
      closedAt: '2026-12-01T00:00:00Z',
      closedReason: 'paid',
      linkedInvoiceId: null,
      enteredPendingAt: null,
    };
    expect(_illegal).toBeDefined();
  });

  it('compile-error: terminal status without closed_at', () => {
    // @ts-expect-error — lapsed cycles require closedAt: string
    const _illegal: RenewalCycle = {
      ...buildCycle(),
      status: 'lapsed',
      closedAt: null,
      closedReason: 'lapsed',
      enteredPendingAt: null,
    };
    expect(_illegal).toBeDefined();
  });

  it('compile-error: non-terminal status with closed_at set', () => {
    // @ts-expect-error — upcoming cycles require closedAt: null
    const _illegal: RenewalCycle = {
      ...buildCycle(),
      status: 'upcoming',
      closedAt: '2026-05-01T00:00:00Z',
      closedReason: null,
      enteredPendingAt: null,
    };
    expect(_illegal).toBeDefined();
  });

  it('compile-error: pending_admin_reactivation without entered_pending_at', () => {
    // @ts-expect-error — pending_admin_reactivation requires enteredPendingAt: string
    const _illegal: RenewalCycle = {
      ...buildCycle(),
      status: 'pending_admin_reactivation',
      enteredPendingAt: null,
      closedAt: null,
      closedReason: null,
    };
    expect(_illegal).toBeDefined();
  });

  it('compile-error: non-pending status with entered_pending_at set', () => {
    // @ts-expect-error — upcoming requires enteredPendingAt: null
    const _illegal: RenewalCycle = {
      ...buildCycle(),
      status: 'upcoming',
      enteredPendingAt: '2026-05-01T00:00:00Z',
      closedAt: null,
      closedReason: null,
    };
    expect(_illegal).toBeDefined();
  });

  it('accepts completed cycle with full anchors', () => {
    expect(
      assertCycleInvariants(
        buildCycle({
          status: 'completed',
          closedAt: '2026-12-01T00:00:00Z',
          closedReason: 'paid',
          linkedInvoiceId: '00000000-0000-0000-0000-0000000000d1',
        }),
      ).ok,
    ).toBe(true);
  });

  it('accepts pending_admin_reactivation with entered_pending_at', () => {
    expect(
      assertCycleInvariants(
        buildCycle({
          status: 'pending_admin_reactivation',
          enteredPendingAt: '2026-07-15T00:00:00Z',
        }),
      ).ok,
    ).toBe(true);
  });
});

describe('isOverdue', () => {
  it('non-terminal + past expires_at = overdue', () => {
    const cycle = buildCycle({
      status: 'awaiting_payment',
      expiresAt: '2026-04-01T00:00:00Z',
    });
    expect(isOverdue(cycle, new Date('2026-05-01T00:00:00Z'))).toBe(true);
  });

  it('non-terminal + future expires_at = not overdue', () => {
    const cycle = buildCycle({ expiresAt: '2027-06-01T00:00:00Z' });
    expect(isOverdue(cycle, new Date('2026-05-01T00:00:00Z'))).toBe(false);
  });

  it('terminal status is never overdue', () => {
    const cycle = buildCycle({
      status: 'cancelled',
      expiresAt: '2025-01-01T00:00:00Z',
      closedAt: '2025-06-01T00:00:00Z',
      closedReason: 'cancelled',
    });
    expect(isOverdue(cycle, new Date('2026-05-01T00:00:00Z'))).toBe(false);
  });
});

describe('daysUntilExpiry', () => {
  it('positive when expiry is in future', () => {
    const cycle = buildCycle({ expiresAt: '2026-05-11T00:00:00Z' });
    expect(daysUntilExpiry(cycle, new Date('2026-05-01T00:00:00Z'))).toBe(10);
  });

  it('negative when expiry is past', () => {
    const cycle = buildCycle({ expiresAt: '2026-04-21T00:00:00Z' });
    expect(daysUntilExpiry(cycle, new Date('2026-05-01T00:00:00Z'))).toBe(-10);
  });

  it('NaN when expires_at is malformed', () => {
    const cycle = buildCycle({ expiresAt: 'malformed' });
    expect(Number.isNaN(daysUntilExpiry(cycle, new Date()))).toBe(true);
  });
});

describe('cycleFrozenPriceSatang', () => {
  it('converts integer THB to satang (× 100)', () => {
    expect(cycleFrozenPriceSatang(buildCycle({ frozenPlanPriceThb: '50000' })))
      .toBe(5_000_000n);
  });

  it('converts decimal THB to satang preserving fractional satang', () => {
    expect(cycleFrozenPriceSatang(buildCycle({ frozenPlanPriceThb: '50000.50' })))
      .toBe(5_000_050n);
    expect(cycleFrozenPriceSatang(buildCycle({ frozenPlanPriceThb: '0.01' })))
      .toBe(1n);
  });

  it('zero THB → 0n satang', () => {
    expect(cycleFrozenPriceSatang(buildCycle({ frozenPlanPriceThb: '0' })))
      .toBe(0n);
    expect(cycleFrozenPriceSatang(buildCycle({ frozenPlanPriceThb: '0.00' })))
      .toBe(0n);
  });

  it('handles single-digit fractional padding (.5 → .50)', () => {
    expect(cycleFrozenPriceSatang(buildCycle({ frozenPlanPriceThb: '100.5' })))
      .toBe(10_050n);
  });
});
