/**
 * T034 spec — RenewalCycle aggregate invariants.
 */
import { describe, expect, it } from 'vitest';
import { parseThbDecimal } from '@/lib/money';
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
 * Builds an active (`upcoming`) cycle. The cast is necessary because
 * the discriminated union can't infer the union arm from a partial
 * spread when callers pass `status` overrides. The cast is acceptable
 * for tests where overrides are trusted; production code SHOULD use
 * the status-aware factories below (`buildCompletedCycle`,
 * `buildLapsedCycle`, etc.) which return the specific union arm WITHOUT
 * a cast — those exercise the DU compile-time guarantee.
 *
 * `frozenPlanPriceThb` is widened to a plain `string` in the override
 * type (vs the domain's branded `ThbDecimal`) so the malformed-input
 * tests below can feed deliberately-invalid values ('', 'abc', '-100',
 * '1e6') WITHOUT routing them through `parseThbDecimal` (which would
 * throw at construction and defeat the runtime-reject assertions). The
 * trailing `as RenewalCycle` re-brands the well-formed default.
 */
function buildCycle(
  overrides: Partial<Omit<RenewalCycle, 'frozenPlanPriceThb'>> & {
    frozenPlanPriceThb?: string;
  } = {},
): RenewalCycle {
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
    anchoredAt: null,
    anchorInvoiceId: null,
    closedAt: null,
    closedReason: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  } as RenewalCycle;
}

// ---------------------------------------------------------------------------
// Status-aware factories — return the specific union arm WITHOUT a cast,
// so the DU compile-time guarantee is exercised. Recommended for new
// tests that want to lock the type contract.
// ---------------------------------------------------------------------------

const baseFields = {
  tenantId: 't',
  cycleId: asCycleId(VALID_UUID),
  memberId: 'm',
  periodFrom: '2026-06-01T00:00:00Z',
  periodTo: '2027-06-01T00:00:00Z',
  expiresAt: '2027-06-01T00:00:00Z',
  cycleLengthMonths: 12,
  tierAtCycleStart: 'regular' as const,
  planIdAtCycleStart: 'p1',
  // Known-valid literal → brand via the constructor (the status-aware
  // factories below spread this and return `RenewalCycle` WITHOUT a
  // cast, so the field must already be `ThbDecimal`).
  frozenPlanPriceThb: parseThbDecimal('50000.00'),
  frozenPlanTermMonths: 12,
  frozenPlanCurrency: 'THB' as const,
  linkedCreditNoteId: null,
  anchoredAt: null,
  anchorInvoiceId: null,
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
} as const;

function buildCompletedCycle(args: {
  closedAt: string;
  closedReason: 'paid' | 'completed_offline' | 'admin_reactivated';
  linkedInvoiceId: string;
}): RenewalCycle {
  return {
    ...baseFields,
    status: 'completed' as const,
    enteredPendingAt: null,
    closedAt: args.closedAt,
    closedReason: args.closedReason,
    linkedInvoiceId: args.linkedInvoiceId,
  };
}

function buildCancelledCycle(args: {
  closedAt: string;
  closedReason: 'cancelled' | 'admin_rejected_with_refund';
}): RenewalCycle {
  return {
    ...baseFields,
    status: 'cancelled' as const,
    enteredPendingAt: null,
    closedAt: args.closedAt,
    closedReason: args.closedReason,
    linkedInvoiceId: null,
  };
}

function buildPendingReactivationCycle(args: {
  enteredPendingAt: string;
}): RenewalCycle {
  return {
    ...baseFields,
    status: 'pending_admin_reactivation' as const,
    enteredPendingAt: args.enteredPendingAt,
    closedAt: null,
    closedReason: null,
    linkedInvoiceId: null,
  };
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
  it('contains the 9 canonical reasons (T115a extended catch-all `lapsed` with `grace_expired` + `payment_failed`)', () => {
    expect(CLOSED_REASONS).toEqual([
      'paid',
      'cancelled',
      'lapsed',
      'grace_expired',
      'payment_failed',
      'completed_offline',
      'admin_reactivated',
      'admin_rejected_with_refund',
      'pending_reactivation_timed_out',
    ]);
  });

  it('grace_expired and payment_failed accept on LapsedCycleFields closedReason', () => {
    // Compile-time assertion via type narrowing — the discriminated
    // union `LapsedCycleFields.closedReason` includes the two new
    // literals so callers can type-narrow correctly.
    const reasons: ReadonlyArray<typeof CLOSED_REASONS[number]> = [
      'lapsed',
      'grace_expired',
      'payment_failed',
      'pending_reactivation_timed_out',
    ];
    expect(reasons.length).toBe(4);
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

  // Round 3: switch from cast-using buildCycle to status-aware factories
  // for these terminal-arm tests so the DU compile-time guarantee is
  // exercised — any future field-shape drift becomes a TS error rather
  // than a runtime Result.err.
  it('accepts completed cycle with full anchors', () => {
    expect(
      assertCycleInvariants(
        buildCompletedCycle({
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
        buildPendingReactivationCycle({
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
    // Status-aware factory exercises DU guarantee.
    const cycle = {
      ...buildCancelledCycle({
        closedAt: '2025-06-01T00:00:00Z',
        closedReason: 'cancelled',
      }),
      expiresAt: '2025-01-01T00:00:00Z',
    };
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

  it('throws on malformed input (defensive guard for cross-module integration)', () => {
    expect(() =>
      cycleFrozenPriceSatang(buildCycle({ frozenPlanPriceThb: '' })),
    ).toThrow(/malformed/);
    expect(() =>
      cycleFrozenPriceSatang(buildCycle({ frozenPlanPriceThb: 'abc' })),
    ).toThrow(/malformed/);
    expect(() =>
      cycleFrozenPriceSatang(buildCycle({ frozenPlanPriceThb: '-100' })),
    ).toThrow(/malformed/);
    expect(() =>
      cycleFrozenPriceSatang(buildCycle({ frozenPlanPriceThb: '50000.999' })),
    ).toThrow(/malformed/);
    expect(() =>
      cycleFrozenPriceSatang(buildCycle({ frozenPlanPriceThb: '1e6' })),
    ).toThrow(/malformed/);
  });
});
