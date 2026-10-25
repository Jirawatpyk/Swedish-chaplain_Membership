/**
 * 130 (D-029) slice 1 — every statement of the small renewals repos carries a
 * `tenant_id` predicate on each tenant-scoped table it names. Inserts set it
 * in VALUES and are not checked here; `email_delivery_events` has no
 * `tenant_id` column, so the checker ignores it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../../helpers/tenant-sql-shape';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[], db: null as unknown }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { recordingDb } = await import('../../../../helpers/tenant-sql-shape');
  const r = recordingDb();
  rec.statements = r.statements;
  rec.db = r.db;
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    db: r.db,
    runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(r.db),
  };
});

const { ANY, SHAPE_TENANT, anyWith, callEach, tenantPredicateViolations, tenantScopedTables } = await import(
  '../../../../helpers/tenant-sql-shape'
);
const { makeDrizzleRenewalReminderEventRepo } = await import(
  '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo'
);
const { makeDrizzleDispatchCandidateRepo } = await import(
  '@/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo'
);
const { makeDrizzleTenantRenewalSchedulePolicyRepo } = await import(
  '@/modules/renewals/infrastructure/drizzle/drizzle-tenant-renewal-schedule-policy-repo'
);
const { makeDrizzleAtRiskOutreachReadRepo } = await import(
  '@/modules/renewals/infrastructure/drizzle/drizzle-at-risk-outreach-read-repo'
);
const { makeDrizzleBounceEventQuery } = await import(
  '@/modules/renewals/infrastructure/drizzle/drizzle-bounce-event-query'
);

const CTX = { slug: SHAPE_TENANT } as never;
const TABLES = tenantScopedTables();

/** Runs the calls, then returns every non-insert statement's violations. */
async function check(repo: unknown, calls: Record<string, readonly unknown[]>, minStatements: number) {
  rec.statements.length = 0;
  await callEach(repo as never, calls);
  const checked = rec.statements.filter((s) => !/^\s*insert/i.test(s.sql));
  // Positive control: the calls reached the database, and each statement
  // names a tenant-scoped table the parse can see.
  expect(checked.length).toBeGreaterThanOrEqual(minStatements);
  expect(checked.every((s) => tenantPredicateViolations(s.sql, TABLES).refs.length > 0)).toBe(true);
  return checked.flatMap((s) =>
    tenantPredicateViolations(s.sql, TABLES).violations.map((v) => `${v} :: ${s.sql.slice(0, 80)}`),
  );
}


describe('small renewals repos — tenant predicate on every statement (130)', () => {
  it('reminder events', async () => {
    const v = await check(makeDrizzleRenewalReminderEventRepo(CTX), {
      transitionStatus: [rec.db, ANY],
      transitionFailedToSent: [rec.db, ANY],
      listForCycle: [SHAPE_TENANT, 'cycle-1'],
      listFailedSince: [SHAPE_TENANT, '2026-01-01', 10],
      listRetryEligible: [SHAPE_TENANT, anyWith({ pageSize: 10 })],
      listRetryExhausted: [SHAPE_TENANT, anyWith({ pageSize: 10 })],
      markRetryExhausted: [rec.db, ANY],
      bulkTransitionToSent: [rec.db, [ANY]],
    }, 8);
    expect(v).toEqual([]);
  });

  it('dispatch candidates', async () => {
    const page = anyWith({ pageSize: 10, cursor: null });
    const v = await check(makeDrizzleDispatchCandidateRepo(CTX), {
      list: [SHAPE_TENANT, page],
      findOne: [SHAPE_TENANT, 'cycle-1'],
      listDueTrackCandidates: [SHAPE_TENANT, page],
    }, 3);
    expect(v).toEqual([]);
  });

  it('schedule policy', async () => {
    const v = await check(makeDrizzleTenantRenewalSchedulePolicyRepo(CTX), {
      findByBucket: [SHAPE_TENANT, 'regular'],
      listAllForTenant: [SHAPE_TENANT],
    }, 2);
    expect(v).toEqual([]);
  });

  it('at-risk outreach read', async () => {
    const v = await check(makeDrizzleAtRiskOutreachReadRepo(CTX), {
      hasOutreachWithinDays: [SHAPE_TENANT, 'member-1', 30],
    }, 1);
    expect(v).toEqual([]);
  });

  it('bounce event query (the contacts read)', async () => {
    const v = await check(makeDrizzleBounceEventQuery(CTX), {
      countBounces: [SHAPE_TENANT, 'member-1', { cycleStartedAt: null, nowIso: '2026-01-01T00:00:00.000Z' }],
    }, 1);
    expect(v).toEqual([]);
  });
});
