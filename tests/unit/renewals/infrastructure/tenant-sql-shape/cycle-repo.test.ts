/**
 * 130 (D-029) slice 2 — every statement of `drizzle-renewal-cycle-repo.ts`
 * carries a `tenant_id` predicate on each tenant-scoped table it names. The
 * gate calls every repo method (`callEach` refuses an unnamed one).
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

const { ANY, SHAPE_TENANT: T, anyWith, callEach, isPureInsert, tenantPredicateViolations, tenantScopedTables } =
  await import('../../../../helpers/tenant-sql-shape');
const { makeDrizzleRenewalCycleRepo } = await import(
  '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo'
);

const TABLES = tenantScopedTables();

describe('renewal cycle repo — tenant predicate on every statement (130 s2)', () => {
  it('every read, update and lock is fenced by tenant_id', async () => {
    const repo = makeDrizzleRenewalCycleRepo({ slug: T } as never);
    const tx = rec.db;
    const page = anyWith({ pageSize: 10, cursor: null, limit: 10, offset: 0 });
    rec.statements.length = 0;
    await callEach(repo as never, {
      insert: [tx, T, ANY],
      findById: [T, 'cycle-1'],
      findByIdInTx: [tx, T, 'cycle-1'],
      findByInvoiceIdInTx: [tx, T, 'inv-1'],
      findActiveForMember: [T, 'member-1'],
      findMostRecentForMember: [T, 'member-1'],
      findActiveForMemberInTx: [tx, T, 'member-1'],
      findLatestCyclesForMembers: [T, ['member-1']],
      findLatestCycleForMember: [T, 'member-1'],
      list: [T, page],
      updateFrozenPlan: [tx, T, 'cycle-1', ANY],
      refreezeOpenCycleForPlanChangeInTx: [tx, T, 'cycle-1', ANY],
      linkInvoice: [tx, T, 'cycle-1', 'inv-1'],
      linkInvoiceAndReconcileFrozenPlanInTx: [tx, T, 'cycle-1', 'inv-1', ANY],
      clearLinkedInvoiceForVoidInTx: [tx, T, 'cycle-1', 'inv-1'],
      acquireCycleLockInTx: [tx, T, 'cycle-1'],
      markRejectRefundInitiatedInTx: [tx, T, 'cycle-1', anyWith({ actorRole: 'admin' })],
      clearRejectRefundMarkerInTx: [tx, T, 'cycle-1', 'refund-1'],
      listCyclesEligibleForLapse: [T, { pageSize: 10 }],
      listCyclesEligibleForAwaitingPayment: [T, { nowIso: '2026-01-01T00:00:00.000Z', pageSize: 10 }],
      listCyclesEligibleForAutoDraft: [
        T,
        { nowIso: '2026-01-01T00:00:00.000Z', leadDaysRolling: 30, leadDaysCalendar: 30, pageSize: 10 },
      ],
      hasLiveMembershipInvoiceForPlanYearInTx: [tx, T, 'member-1', 2026],
      findMembershipInvoiceInTx: [tx, T, 'inv-1', { forUpdate: true }],
      clearStaleLinkedInvoiceInTx: [tx, T, 'cycle-1', 'inv-1'],
      findByAutoDraftInvoiceIdInTx: [tx, T, 'inv-1'],
      findCyclesByAutoDraftInvoiceIds: [T, ['inv-1']],
      listMembershipInvoicesForPlanYearInTx: [tx, T, 'member-1', 2026],
      listMembershipCoverageForMemberInTx: [tx, T, 'member-1'],
      listMembershipCoverageForMembers: [T, ['member-1']],
      stampAutoDraftInvoiceIdInTx: [tx, T, 'cycle-1', 'inv-1'],
      listStaleAutoDrafts: [T],
      listIssuedAutoInvoiceOrphans: [T],
      loadPipelineMoneyRaw: [T, { nowIso: '2026-01-01T00:00:00.000Z', windowDays: 30, fiscalYearStartMonth: 1 }],
      loadSettlementPreview: [{ tenantId: T, cycleIds: ['cycle-1'] }],
      transitionStatus: [tx, T, 'cycle-1', anyWith({ from: 'upcoming', to: 'awaiting_payment' })],
      listEligibleForDispatch: [T, { cutoff: '2026-01-01T00:00:00.000Z', pageSize: 10 }],
      listMembersWithoutCycle: [T, page],
      loadPipelinePage: [T, page],
      countCyclesByExpiryMonth: [T, { nowIso: '2026-01-01T00:00:00.000Z', timezone: 'Asia/Bangkok' }],
      countCyclesForMemberInTx: [tx, T, 'member-1'],
      findMaxPaidThroughForMemberInTx: [tx, T, 'member-1'],
      countSettledCyclesForMemberInTx: [tx, T, 'member-1', 'cycle-1'],
      findOpenCycleForMemberInTx: [tx, T, 'member-1'],
      findLatestCycleForMemberInTx: [tx, T, 'member-1'],
      reanchorPeriodInTx: [tx, T, 'cycle-1', anyWith({ anchorInvoiceId: null })],
    });
    // Advisory locks name no table (the key is tenant:cycle) — not a read.
    const checked = rec.statements.filter((s) => !isPureInsert(s.sql) && !/^\s*select pg_advisory/i.test(s.sql));
    // Positive control: the calls reached the database (≥ one statement per
    // non-insert method) and each statement names a tenant-scoped table.
    expect(checked.length).toBeGreaterThanOrEqual(44);
    expect(checked.filter((s) => tenantPredicateViolations(s, TABLES).refs.length === 0).map((s) => s.sql.slice(0, 80))).toEqual([]);
    const violations = checked.flatMap((s) =>
      tenantPredicateViolations(s, TABLES).violations.map((v) => `${v} :: ${s.sql.slice(0, 90)}`),
    );
    expect(violations).toEqual([]);
  });

  it('the month-filtered pipeline page is fenced too (a branch the call map does not reach)', async () => {
    const repo = makeDrizzleRenewalCycleRepo({ slug: T } as never);
    rec.statements.length = 0;
    await repo
      .loadPipelinePage(T, anyWith({ pageSize: 10, cursor: null, monthFilter: '2026-02', nowIso: '2026-01-01T00:00:00.000Z' }) as never)
      .catch(() => undefined);
    const page = rec.statements;
    expect(page.length).toBeGreaterThan(0);
    expect(page.flatMap((s) => tenantPredicateViolations(s, TABLES).violations)).toEqual([]);
  });
});
