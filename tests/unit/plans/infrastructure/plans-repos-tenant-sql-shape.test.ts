/**
 * 130 (D-029) slice 4 — every statement of the plans repos carries a
 * `tenant_id` predicate on each tenant-scoped table it names. Supersedes
 * research.md § 7.1's "no explicit WHERE tenant_id" for this module.
 * `callEach` refuses an unnamed method; the source scans cover statements
 * that run only once an earlier read returns rows (the recording db answers
 * none).
 */
import { readFileSync } from 'node:fs';
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

const {
  ANY,
  SHAPE_TENANT: T,
  anyWith,
  callEach,
  gateViolations,
  tenantScopedTables,
  unfencedRawSql,
  unfencedWheres,
} = await import('../../../helpers/tenant-sql-shape');
const { planRepo } = await import('@/modules/plans/infrastructure/db/plan-repo');
const { drizzleScheduledPlanChangeRepo } = await import(
  '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo'
);

const TABLES = tenantScopedTables();
const CTX = { slug: T } as never;
const noop = async () => undefined;
const PLAN_SRC = 'src/modules/plans/infrastructure/db/plan-repo.ts';
const SCHEDULED_SRC = 'src/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo.ts';

function violationsOf(statements: readonly RecordedStatement[]): string[] {
  const { blind, violations } = gateViolations(statements, TABLES);
  expect(blind).toEqual([]);
  return violations;
}

describe('plans repos — tenant predicate on every statement (130 s4)', () => {
  it('plan repo', async () => {
    rec.statements.length = 0;
    // The DEFAULT list path: every optional filter pinned off.
    const filter = anyWith({ year: undefined, category: undefined, q: undefined, activeOnly: undefined, showDeleted: undefined });
    await callEach(planRepo as never, {
      findByTenantAndYear: [CTX, filter],
      findOne: [CTX, 'large', 2026],
      insert: [CTX, ANY, noop],
      update: [CTX, 'large', 2026, anyWith({ planName: { en: 'Large' } }), 'user-1', noop],
      setActive: [CTX, 'large', 2026, false, 'user-1', noop],
      softDeleteGuarded: [CTX, 'large', 2026, new Date('2026-01-01T00:00:00.000Z'), 'user-1', noop],
      undelete: [CTX, 'large', 2026, 'user-1', noop],
      cloneYear: [CTX, 2026, 2027, false, 'user-1', noop],
    });
    expect(rec.statements.length).toBeGreaterThanOrEqual(8);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('plan list with every filter on (year, category, search, active-only, show-deleted)', async () => {
    rec.statements.length = 0;
    await planRepo
      .findByTenantAndYear(CTX, { year: 2026, category: 'corporate', q: 'large', activeOnly: true, showDeleted: true } as never)
      .catch(() => undefined);
    expect(rec.statements.length).toBe(1);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('scheduled plan-change repo', async () => {
    rec.statements.length = 0;
    await callEach(drizzleScheduledPlanChangeRepo as never, {
      supersedeAndInsertPendingAtomically: [CTX, ANY, rec.db, noop],
      findPendingForCycle: [CTX, 'member-1', 'cycle-1'],
      findById: [CTX, 'change-1'],
      transitionStatus: [CTX, 'change-1', 'applied', noop],
      listForMember: [CTX, 'member-1'],
    });
    expect(rec.statements.length).toBeGreaterThanOrEqual(5);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('every .where( and hand-written sql block in both sources names tenant_id', () => {
    const plan = readFileSync(PLAN_SRC, 'utf8');
    // `conditions` is the plan-list filter array, seeded with the tenant
    // predicate and proven by the call-map case above.
    expect(unfencedWheres(plan)).toEqual(['and(...conditions)']);
    expect(unfencedRawSql(plan, TABLES)).toEqual([]);
    const scheduled = readFileSync(SCHEDULED_SRC, 'utf8');
    expect(unfencedWheres(scheduled)).toEqual([]);
    expect(unfencedRawSql(scheduled, TABLES)).toEqual([]);
  });
});
