/**
 * 135 — the pure parts of the stale test-tenant sweep: which statements a
 * table's delete issues (the automatic sweep must never take the ACCESS
 * EXCLUSIVE lock `ALTER TABLE … DISABLE TRIGGER` needs on a shared branch),
 * and which tenants an automatic run skips as already stuck.
 */
import { describe, expect, it } from 'vitest';
import {
  deleteStatementsFor,
  isStuckOnRefundCreditNoteCycle,
  partitionCandidates,
} from '../../../scripts/lib/leaked-test-tenants';

describe('partitionCandidates (135 review)', () => {
  const owned = new Map<string, Map<string, number>>([
    ['test-plain', new Map([['members', 3]])],
    ['test-cycle', new Map([['refunds', 1], ['credit_notes', 1]])],
    ['test-guarded', new Map([['broadcast_deliveries', 2], ['broadcasts', 1]])],
  ]);
  const all = ['test-plain', 'test-cycle', 'test-guarded'];

  it('the automatic sweep skips the tenants it cannot fully drain', () => {
    expect(
      partitionCandidates(all, owned, { allowTriggerDisable: false, skipUndrainable: true }),
    ).toEqual({ eligible: ['test-plain'], skippedStuck: ['test-cycle', 'test-guarded'] });
  });

  it('the operator run takes every candidate', () => {
    expect(partitionCandidates(all, owned, { allowTriggerDisable: true })).toEqual({
      eligible: all,
      skippedStuck: [],
    });
  });
});

describe('deleteStatementsFor (135)', () => {
  it('a trigger-guarded table disables its trigger only when allowed', () => {
    const allowed = deleteStatementsFor('broadcast_deliveries', true);
    expect(allowed?.some((s) => s.startsWith('ALTER TABLE'))).toBe(true);

    const refused = deleteStatementsFor('broadcast_deliveries', false);
    expect(refused).toBeNull();
  });

  it('a plain table is one DELETE either way', () => {
    expect(deleteStatementsFor('members', false)).toEqual(['DELETE FROM "members" WHERE tenant_id = $1']);
    expect(deleteStatementsFor('members', true)).toEqual(['DELETE FROM "members" WHERE tenant_id = $1']);
  });
});

describe('isStuckOnRefundCreditNoteCycle (135)', () => {
  it('a tenant an earlier sweep drained down to the refund/credit-note cycle is skipped', () => {
    expect(isStuckOnRefundCreditNoteCycle(['credit_notes', 'refunds', 'payments', 'invoices'])).toBe(true);
  });

  it('a tenant that still owns its tenant_invoice_settings row is not (it has never been drained)', () => {
    expect(
      isStuckOnRefundCreditNoteCycle(['credit_notes', 'refunds', 'tenant_invoice_settings']),
    ).toBe(false);
  });

  it('a tenant without the cycle is not', () => {
    expect(isStuckOnRefundCreditNoteCycle(['members', 'invoices'])).toBe(false);
  });
});
