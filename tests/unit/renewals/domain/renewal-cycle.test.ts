/**
 * T034 spec — RenewalCycle aggregate invariants.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSED_REASONS,
  asCycleId,
  parseCycleId,
  assertCycleInvariants,
  isOverdue,
  daysUntilExpiry,
  type RenewalCycle,
} from '@/modules/renewals/domain/renewal-cycle';

const VALID_UUID = '00000000-0000-0000-0000-0000000000c1';

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return {
    tenantId: 't',
    cycleId: asCycleId(VALID_UUID),
    memberId: 'm',
    status: 'upcoming',
    periodFrom: '2026-06-01T00:00:00Z',
    periodTo: '2027-06-01T00:00:00Z',
    expiresAt: '2027-06-01T00:00:00Z',
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular',
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    enteredPendingAt: null,
    linkedInvoiceId: null,
    linkedCreditNoteId: null,
    closedAt: null,
    closedReason: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
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

  it('rejects completed without linked_invoice_id', () => {
    const r = assertCycleInvariants(
      buildCycle({
        status: 'completed',
        closedAt: '2026-12-01T00:00:00Z',
        closedReason: 'paid',
        linkedInvoiceId: null,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('completed_requires_invoice');
  });

  it('rejects terminal status without closed_at', () => {
    const r = assertCycleInvariants(
      buildCycle({
        status: 'lapsed',
        closedAt: null,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('closed_at_terminal_mismatch');
  });

  it('rejects non-terminal status with closed_at set', () => {
    const r = assertCycleInvariants(
      buildCycle({
        status: 'upcoming',
        closedAt: '2026-05-01T00:00:00Z',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('closed_at_terminal_mismatch');
  });

  it('rejects pending_admin_reactivation without entered_pending_at', () => {
    const r = assertCycleInvariants(
      buildCycle({
        status: 'pending_admin_reactivation',
        enteredPendingAt: null,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('pending_at_status_mismatch');
  });

  it('rejects non-pending status with entered_pending_at set', () => {
    const r = assertCycleInvariants(
      buildCycle({
        status: 'upcoming',
        enteredPendingAt: '2026-05-01T00:00:00Z',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('pending_at_status_mismatch');
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
