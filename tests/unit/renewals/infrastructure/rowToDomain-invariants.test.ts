/**
 * F8 Round 4 — `rowToDomain` invariant tests via `assertPresent` helper.
 *
 * Round 3 added `assertPresent<T>()` (drizzle-renewal-cycle-repo.ts) to
 * collapse 5 inline null-throw blocks. The throws fire when a DB row
 * has a CHECK-violating NULL anchor for a terminal status (e.g.
 * `status='completed'` with `closedAt=null`). These tests construct
 * malformed rows + assert each terminal-status arm throws with the
 * documented message format ("F8 invariant violation: cycle X status=Y
 * but Z is null") so a future refactor that drops the cycleId or field
 * name from the message regresses noisily.
 */
import { describe, expect, it } from 'vitest';
import {
  assertPresent,
  rowToDomain,
} from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import type { RenewalCycleRow } from '@/modules/renewals/infrastructure/schema-renewal-cycles';

const VALID_UUID = '00000000-0000-0000-0000-000000000abc';
const PERIOD_FROM = new Date('2026-06-01T00:00:00Z');
const PERIOD_TO = new Date('2027-06-01T00:00:00Z');
const NOW = new Date('2026-05-01T00:00:00Z');

function buildRow(overrides: Partial<RenewalCycleRow> = {}): RenewalCycleRow {
  return {
    tenantId: 't',
    cycleId: VALID_UUID,
    memberId: 'm',
    status: 'upcoming' as RenewalCycleRow['status'],
    periodFrom: PERIOD_FROM,
    periodTo: PERIOD_TO,
    expiresAt: PERIOD_TO,
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular',
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    enteredPendingAt: null,
    linkedInvoiceId: null,
    anchoredAt: null,
    anchorInvoiceId: null,
    linkedCreditNoteId: null,
    closedAt: null,
    closedReason: null,
    cancelReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as RenewalCycleRow;
}

describe('assertPresent', () => {
  it('passes for non-null value (no throw)', () => {
    expect(() => assertPresent('value', VALID_UUID, 'upcoming', 'foo')).not.toThrow();
  });

  it('throws on null with cycleId + status + field in message', () => {
    expect(() => assertPresent(null, VALID_UUID, 'completed', 'closedAt')).toThrow(
      /F8 invariant violation: cycle 00000000-0000-0000-0000-000000000abc status=completed but closedAt is null/,
    );
  });

  it('throws on undefined (loose-equality also catches undefined)', () => {
    expect(() => assertPresent(undefined, VALID_UUID, 'lapsed', 'closedAt')).toThrow(
      /F8 invariant violation/,
    );
  });
});

describe('rowToDomain — terminal-status invariant violations', () => {
  it('completed without closedAt throws naming closedAt', () => {
    const row = buildRow({
      status: 'completed' as RenewalCycleRow['status'],
      closedAt: null,
      linkedInvoiceId: 'inv-1',
      closedReason: 'paid' as RenewalCycleRow['closedReason'],
    });
    expect(() => rowToDomain(row)).toThrow(/status=completed but closedAt is null/);
  });

  it('completed without linkedInvoiceId throws naming linkedInvoiceId', () => {
    const row = buildRow({
      status: 'completed' as RenewalCycleRow['status'],
      closedAt: NOW,
      linkedInvoiceId: null,
      closedReason: 'paid' as RenewalCycleRow['closedReason'],
    });
    expect(() => rowToDomain(row)).toThrow(/status=completed but linkedInvoiceId is null/);
  });

  it('lapsed without closedAt throws naming closedAt', () => {
    const row = buildRow({
      status: 'lapsed' as RenewalCycleRow['status'],
      closedAt: null,
      closedReason: 'lapsed' as RenewalCycleRow['closedReason'],
    });
    expect(() => rowToDomain(row)).toThrow(/status=lapsed but closedAt is null/);
  });

  it('cancelled without closedAt throws naming closedAt', () => {
    const row = buildRow({
      status: 'cancelled' as RenewalCycleRow['status'],
      closedAt: null,
      closedReason: 'cancelled' as RenewalCycleRow['closedReason'],
    });
    expect(() => rowToDomain(row)).toThrow(/status=cancelled but closedAt is null/);
  });

  it('pending_admin_reactivation without enteredPendingAt throws', () => {
    const row = buildRow({
      status: 'pending_admin_reactivation' as RenewalCycleRow['status'],
      enteredPendingAt: null,
    });
    expect(() => rowToDomain(row)).toThrow(
      /status=pending_admin_reactivation but enteredPendingAt is null/,
    );
  });

  it('every error message names the cycleId for Sentry triage', () => {
    const row = buildRow({
      status: 'completed' as RenewalCycleRow['status'],
      closedAt: null,
    });
    expect(() => rowToDomain(row)).toThrow(VALID_UUID);
  });
});
