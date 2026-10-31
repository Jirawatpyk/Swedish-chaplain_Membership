/**
 * #49 — the probable-duplicate lookup carries a `tenant_id` predicate on
 * every tenant-scoped table it names (D-029), alongside RLS.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../helpers/tenant-sql-shape';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[], db: null as unknown }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { recordingDb } = await import('../../../helpers/tenant-sql-shape');
  const r = recordingDb();
  rec.statements = r.statements;
  rec.db = r.db;
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    db: r.db,
    runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(r.db),
  };
});

const { SHAPE_TENANT: T, gateViolations, tenantScopedTables } = await import(
  '../../../helpers/tenant-sql-shape'
);
const { makeDrizzleRefundsRepo } = await import(
  '@/modules/payments/infrastructure/repos/drizzle-refunds-repo'
);

describe('refunds repo — findRecentSameAmountSucceeded is tenant-fenced (#49)', () => {
  it('names refunds with a bound tenant predicate, and finds nothing on an empty table', async () => {
    rec.statements.length = 0;
    const repo = makeDrizzleRefundsRepo(T);
    const found = await repo.findRecentSameAmountSucceeded(
      rec.db,
      T,
      'pmt_01JABCDEFGHJKMNPQRSTVWXYZ' as never,
      350_000n as never,
      '2026-05-14T03:14:22.456Z',
    );
    expect(found).toBeNull();
    expect(rec.statements).toHaveLength(1);
    expect(rec.statements[0]!.sql).toMatch(/from "refunds"/i);
    // Financial review L1: a refund that sat pending, then settled in the
    // window, counts too.
    expect(rec.statements[0]!.sql).toMatch(/"completed_at" >= \$\d+/i);
    // Code review: the date shown and the order are when it was REFUNDED —
    // its settlement, else its start — not only when it was initiated.
    expect(rec.statements[0]!.sql).toMatch(
      /order by coalesce\("refunds"\."completed_at", "refunds"\."initiated_at"\) desc/i,
    );
    const { blind, violations } = gateViolations(rec.statements, tenantScopedTables());
    expect(blind).toEqual([]);
    expect(violations).toEqual([]);
  });
});
