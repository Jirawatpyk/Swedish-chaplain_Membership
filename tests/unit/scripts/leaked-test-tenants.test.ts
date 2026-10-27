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
    // Eight characters, but not hex: an alphanumeric suffix must not pass.
    expect(GENERATED_TEST_SLUG.test('test-sweep-fixedabc')).toBe(false);
  });
});

describe('AUTOMATIC_SWEEP_OPTIONS (135 review)', () => {
  it('is safe for a shared branch', () => {
    // The whole object: a new key or a changed value must show up here.
    expect(AUTOMATIC_SWEEP_OPTIONS).toEqual({
      maxAgeHours: 6,
      apply: true,
      includeUndatable: false,
      allowTriggerDisable: false,
      skipUndrainable: true,
      slugPattern: GENERATED_TEST_SLUG,
      budgetMs: 20_000,
      lockTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    });
  });
});

describe('sweepLeakedTestTenants wiring (135 review)', () => {
  // A stand-in for the postgres client: the catalogue, the candidate, its age
  // and what it owns come from these answers. Every statement — on the client
  // or inside a transaction / savepoint — is recorded in `sent`.
  function fakeSql(
    owned: Array<{ tbl: string; n: number }>,
    {
      slug = 'test-sweep-a1b2c3d4',
      slugs = [slug],
      failOn,
    }: { slug?: string; slugs?: string[]; failOn?: string } = {},
  ) {
    const sent: string[] = [];
    const tagged = vi.fn(async (strings: TemplateStringsArray) => {
      sent.push(strings.join('?'));
      return [
        { name: 'broadcast_deliveries', has_created_at: true },
        { name: 'members', has_created_at: true },
        { name: 'tenant_invoice_settings', has_created_at: true },
      ];
    });
    const unsafe = vi.fn(async (query: string) => {
      sent.push(query);
      if (query.includes('count(*)::int AS n')) return slugs.flatMap((s) => owned.map((o) => ({ ...o, tenant_id: s })));
      if (query.includes('max(newest)')) return slugs.map((s) => ({ tenant_id: s, newest: new Date(Date.now() - 7 * 3_600_000) }));
      if (failOn !== undefined && query.startsWith(failOn)) throw new Error('refused');
      if (query.startsWith('DELETE')) return Object.assign([], { count: 2 });
      return slugs.map((s) => ({ tenant_id: s }));
    });
    const client = Object.assign(tagged, { unsafe }) as unknown as Record<string, unknown>;
    client['savepoint'] = async (fn: (sp: unknown) => Promise<unknown>) => fn(client);
    client['begin'] = async (fn: (tx: unknown) => Promise<unknown>) => {
      sent.push('BEGIN');
      return fn(client);
    };
    return { sql: client as unknown as postgres.Sql, sent, slug };
  }

  it('the automatic options skip an undrained guarded tenant: no DELETE is ever sent', async () => {
    const { sql, sent, slug } = fakeSql([{ tbl: 'broadcast_deliveries', n: 2 }]);
    const report = await sweepLeakedTestTenants(sql, AUTOMATIC_SWEEP_OPTIONS);
    expect(report.skippedStuck).toEqual([slug]);
    expect(report.eligible).toEqual([]);
    expect(sent.some((s) => s.startsWith('DELETE') || s.startsWith('ALTER'))).toBe(false);
  });

  it('without skipUndrainable the same tenant is attempted (still never with ALTER TABLE)', async () => {
    const { sql, sent } = fakeSql([{ tbl: 'members', n: 2 }, { tbl: 'broadcast_deliveries', n: 2 }]);
    const report = await sweepLeakedTestTenants(sql, { ...AUTOMATIC_SWEEP_OPTIONS, skipUndrainable: false });
    expect(sent).toContain('DELETE FROM "members" WHERE tenant_id = $1');
    expect(report.deletedPerTable.get('members')).toBe(2);
    expect(sent.some((s) => s.startsWith('ALTER'))).toBe(false);
  });

  it('every read and every drain runs under the SET LOCAL timeouts', async () => {
    const { sql, sent } = fakeSql([{ tbl: 'members', n: 2 }]);
    await sweepLeakedTestTenants(sql, AUTOMATIC_SWEEP_OPTIONS);
    const lock = sent.filter((s) => s === 'SET LOCAL lock_timeout = 5000').length;
    const stmt = sent.filter((s) => s === 'SET LOCAL statement_timeout = 30000').length;
    // 4 discovery reads + 1 tenant drain, each inside its own transaction.
    expect(lock).toBe(5);
    expect(stmt).toBe(5);
    sent.forEach((s, i) => {
      if (s === 'SET LOCAL lock_timeout = 5000') expect(sent[i - 1]).toBe('BEGIN');
    });
  });

  it('a delete is counted only when its savepoint held (a failed re-enable counts nothing)', async () => {
    const { sql } = fakeSql([{ tbl: 'broadcast_deliveries', n: 2 }], { failOn: 'ALTER TABLE "broadcast_deliveries" ENABLE' });
    const report = await sweepLeakedTestTenants(sql, {
      maxAgeHours: 6,
      apply: true,
      includeUndatable: false,
      allowTriggerDisable: true,
    });
    expect(report.deletedPerTable.has('broadcast_deliveries')).toBe(false);
    expect(report.stuck).toEqual([{ slug: 'test-sweep-a1b2c3d4', left: ['broadcast_deliveries'] }]);
  });

  it('the slug pattern and the time budget apply before any DELETE', async () => {
    const fixed = fakeSql([{ tbl: 'members', n: 1 }], { slug: 'test-suppression-explain' });
    const r1 = await sweepLeakedTestTenants(fixed.sql, AUTOMATIC_SWEEP_OPTIONS);
    expect(r1.slugs).toBe(0);
    expect(fixed.sent.some((s) => s.startsWith('DELETE'))).toBe(false);

    // A spent budget still drains one tenant per run, then defers the rest.
    const spent = fakeSql([{ tbl: 'members', n: 1 }], { slugs: ['test-sweep-a1b2c3d4', 'test-sweep-b1b2c3d4'] });
    const r2 = await sweepLeakedTestTenants(spent.sql, { ...AUTOMATIC_SWEEP_OPTIONS, budgetMs: 0 });
    expect(r2.fullyCleaned).toBe(1);
    expect(r2.skippedBudget).toEqual(['test-sweep-b1b2c3d4']);
  });

  it('the budget counts discovery time', async () => {
    // Each Date.now() call advances the clock by 1 s; discovery alone makes
    // several calls, so a 2 s budget is spent before the second tenant.
    let t = 1_800_000_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (t += 1_000));
    try {
      const { sql } = fakeSql([{ tbl: 'members', n: 1 }], {
        slugs: ['test-sweep-a1b2c3d4', 'test-sweep-b1b2c3d4'],
      });
      const r = await sweepLeakedTestTenants(sql, { ...AUTOMATIC_SWEEP_OPTIONS, budgetMs: 2_000 });
      expect(r.fullyCleaned).toBe(1);
      expect(r.skippedBudget).toEqual(['test-sweep-b1b2c3d4']);
    } finally {
      now.mockRestore();
    }
  });
});
