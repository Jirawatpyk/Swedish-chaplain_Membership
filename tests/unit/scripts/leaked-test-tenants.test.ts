/**
 * 135 — the pure parts of the stale test-tenant sweep: which statements a
 * table's delete issues (the automatic sweep must never take the ACCESS
 * EXCLUSIVE lock `ALTER TABLE … DISABLE TRIGGER` needs on a shared branch),
 * which tenants an automatic run skips, the options the globalSetup runs
 * with, and that a skipped tenant never reaches a transaction.
 */
import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  AUTOMATIC_SWEEP_OPTIONS,
  GENERATED_TEST_SLUG,
  deleteStatementsFor,
  isStuckOnRefundCreditNoteCycle,
  partitionCandidates,
  sweepLeakedTestTenants,
} from '../../../scripts/lib/leaked-test-tenants';

describe('deleteStatementsFor (135)', () => {
  it('a trigger-guarded table disables, deletes and re-enables, in that order, only when allowed', () => {
    expect(deleteStatementsFor('broadcast_deliveries', true)).toEqual([
      'ALTER TABLE "broadcast_deliveries" DISABLE TRIGGER "broadcast_deliveries_no_delete"',
      'DELETE FROM "broadcast_deliveries" WHERE tenant_id = $1',
      'ALTER TABLE "broadcast_deliveries" ENABLE TRIGGER "broadcast_deliveries_no_delete"',
    ]);
    expect(deleteStatementsFor('broadcast_deliveries', false)).toBeNull();
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

  it('one side of the cycle alone is not stuck', () => {
    expect(isStuckOnRefundCreditNoteCycle(['credit_notes', 'members'])).toBe(false);
    expect(isStuckOnRefundCreditNoteCycle(['refunds'])).toBe(false);
  });

  it('a tenant without the cycle is not', () => {
    expect(isStuckOnRefundCreditNoteCycle(['members', 'invoices'])).toBe(false);
  });
});

describe('partitionCandidates (135 review)', () => {
  const owned = new Map<string, Map<string, number>>([
    ['test-plain', new Map([['members', 3]])],
    ['test-cycle', new Map([['refunds', 1], ['credit_notes', 1]])],
    ['test-guarded', new Map([['broadcast_deliveries', 2], ['broadcasts', 1]])],
    [
      'test-guarded-first',
      new Map([['broadcast_deliveries', 2], ['tenant_invoice_settings', 1]]),
    ],
  ]);
  const all = ['test-plain', 'test-cycle', 'test-guarded', 'test-guarded-first'];

  it('the automatic sweep skips tenants an earlier drain left undrainable', () => {
    expect(
      partitionCandidates(all, owned, { allowTriggerDisable: false, skipUndrainable: true }),
    ).toEqual({
      // `test-guarded-first` still owns its tenant_invoice_settings row: the
      // first drain takes it off the list the platform crons enumerate.
      eligible: ['test-plain', 'test-guarded-first'],
      skippedStuck: ['test-cycle', 'test-guarded'],
    });
  });

  it('the operator run takes every candidate', () => {
    expect(partitionCandidates(all, owned, { allowTriggerDisable: true })).toEqual({
      eligible: all,
      skippedStuck: [],
    });
  });
});

describe('GENERATED_TEST_SLUG (135 review)', () => {
  it('matches createTestTenant slugs and nothing fixed', () => {
    expect(GENERATED_TEST_SLUG.test('test-swecham-a1b2c3d4')).toBe(true);
    expect(GENERATED_TEST_SLUG.test('test-a1b2c3d4')).toBe(true);
    expect(GENERATED_TEST_SLUG.test('test-suppression-explain')).toBe(false);
    expect(GENERATED_TEST_SLUG.test('test-adopt-tenant')).toBe(false);
    expect(GENERATED_TEST_SLUG.test('swecham')).toBe(false);
  });
});

describe('AUTOMATIC_SWEEP_OPTIONS (135 review)', () => {
  it('is safe for a shared branch', () => {
    expect(AUTOMATIC_SWEEP_OPTIONS).toMatchObject({
      maxAgeHours: 6,
      apply: true,
      includeUndatable: false,
      allowTriggerDisable: false,
      skipUndrainable: true,
      slugPattern: GENERATED_TEST_SLUG,
    });
    expect(AUTOMATIC_SWEEP_OPTIONS.budgetMs).toBeGreaterThan(0);
    expect(AUTOMATIC_SWEEP_OPTIONS.lockTimeoutMs).toBeGreaterThan(0);
    expect(AUTOMATIC_SWEEP_OPTIONS.statementTimeoutMs).toBeGreaterThan(0);
  });
});

describe('sweepLeakedTestTenants wiring (135 review)', () => {
  // A stand-in for the postgres client: the catalogue, the candidate, its age
  // and what it owns come from these answers; `begin` records any transaction.
  function fakeSql(owned: Array<{ tbl: string; n: number }>) {
    const slug = 'test-sweep-a1b2c3d4';
    const begin = vi.fn(async () => []);
    const tagged = vi.fn(async () => [
      { name: 'broadcast_deliveries', has_created_at: true },
      { name: 'members', has_created_at: true },
      { name: 'tenant_invoice_settings', has_created_at: true },
    ]);
    const unsafe = vi.fn(async (query: string) => {
      if (query.includes('count(*)::int AS n')) return owned.map((o) => ({ ...o, tenant_id: slug }));
      if (query.includes('max(newest)')) return [{ tenant_id: slug, newest: new Date(Date.now() - 7 * 3_600_000) }];
      return [{ tenant_id: slug }];
    });
    const sql = Object.assign(tagged, { unsafe, begin }) as unknown as postgres.Sql;
    return { sql, begin, slug };
  }

  it('the automatic options skip an undrained guarded tenant without opening a transaction', async () => {
    const { sql, begin, slug } = fakeSql([{ tbl: 'broadcast_deliveries', n: 2 }]);
    const report = await sweepLeakedTestTenants(sql, AUTOMATIC_SWEEP_OPTIONS);
    expect(report.skippedStuck).toEqual([slug]);
    expect(report.eligible).toEqual([]);
    expect(begin).not.toHaveBeenCalled();
  });

  it('without skipUndrainable the same tenant is attempted', async () => {
    const { sql, begin } = fakeSql([{ tbl: 'broadcast_deliveries', n: 2 }]);
    await sweepLeakedTestTenants(sql, { ...AUTOMATIC_SWEEP_OPTIONS, skipUndrainable: false });
    expect(begin).toHaveBeenCalledTimes(1);
  });
});
