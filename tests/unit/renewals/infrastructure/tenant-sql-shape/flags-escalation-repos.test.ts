/**
 * 130 (D-029) slice 3 — every statement of the member renewal-flags repo and
 * the renewal escalation-task repo carries a `tenant_id` predicate on each
 * tenant-scoped table it names. `callEach` refuses an unnamed method; the
 * source scan covers statements that only run once an earlier read returns
 * rows (the recording db answers none).
 */
import { readFileSync } from 'node:fs';
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

const {
  ANY,
  SHAPE_TENANT: T,
  anyWith,
  callEach,
  isPureInsert,
  tenantPredicateViolations,
  tenantScopedTables,
  unfencedRawSql,
  unfencedWheres,
} = await import('../../../../helpers/tenant-sql-shape');
const { makeDrizzleMemberRenewalFlagsRepo, makeDrizzleMemberRenewalFlagsRepoWithTenant } = await import(
  '@/modules/renewals/infrastructure/drizzle/drizzle-member-renewal-flags-repo'
);
const { makeDrizzleRenewalEscalationTaskRepo } = await import(
  '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-escalation-task-repo'
);

const TABLES = tenantScopedTables();
const CTX = { slug: T } as never;
const OFF = {
  cursor: null,
  pageSize: 10,
  limit: 10,
  statusFilter: undefined,
  assignedToUserIdFilter: undefined,
  taskTypeFilter: undefined,
  overdueOnly: undefined,
  overdueThresholdDays: undefined,
  band: undefined,
};
const FLAGS_SRC = 'src/modules/renewals/infrastructure/drizzle/drizzle-member-renewal-flags-repo.ts';
const ESCALATION_SRC = 'src/modules/renewals/infrastructure/drizzle/drizzle-renewal-escalation-task-repo.ts';

function violationsOf(statements: readonly RecordedStatement[]): string[] {
  const checked = statements.filter((s) => !isPureInsert(s.sql));
  // Positive control: every read/update names a tenant table the parse sees.
  // An `insert … on conflict … where` writes its tenant in VALUES and names none.
  const reads = checked.filter((s) => !s.sql.trimStart().toLowerCase().startsWith('insert'));
  expect(reads.filter((s) => tenantPredicateViolations(s, TABLES).refs.length === 0).map((s) => s.sql.slice(0, 80))).toEqual([]);
  return checked.flatMap((s) =>
    tenantPredicateViolations(s, TABLES).violations.map((v) => `${v} :: ${s.sql.slice(0, 90)}`),
  );
}

describe('flags + escalation repos — tenant predicate on every statement (130 s3)', () => {
  it('member renewal flags', async () => {
    const tx = rec.db;
    rec.statements.length = 0;
    await callEach(makeDrizzleMemberRenewalFlagsRepo(CTX) as never, {
      setEmailUnverified: [tx, T, 'member-1'],
      clearEmailUnverified: [tx, T, 'member-1'],
      setRenewalRemindersOptedOut: [tx, T, 'member-1'],
      clearRenewalRemindersOptedOut: [tx, T, 'member-1'],
      setBlockedFromAutoReactivation: [tx, T, ANY],
      readBlockedFromAutoReactivation: [tx, T, 'member-1'],
      readReactivationGuardsInTx: [tx, T, 'member-1'],
      findErasedMemberIds: [['member-1']],
      readRenewalRemindersOptedOut: [tx, T, 'member-1'],
      clearBlockedFromAutoReactivation: [tx, T, 'member-1'],
      setRiskScore: [tx, T, 'member-1', ANY],
      listActiveMemberIdsForAtRiskRecompute: [tx, T, 10],
      bulkSetRiskScores: [tx, T, [anyWith({ score: 50, band: 'medium' })], new Date('2026-01-01T00:00:00.000Z')],
      gatherAtRiskFactorsForTenant: [tx, T],
      listAtRiskWidgetMembers: [tx, T, anyWith(OFF)],
      setRiskSnoozedUntil: [tx, T, 'member-1', '2026-02-01T00:00:00.000Z'],
      hasUnreconciledPaidMembershipInvoice: [T, 'member-1'],
      listMemberIdsWithUnreconciledPaidMembershipInvoice: [T],
    });
    expect(rec.statements.length).toBeGreaterThanOrEqual(18);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('member renewal flags — the band-filtered widget and the WithTenant wrapper', async () => {
    rec.statements.length = 0;
    const repo = makeDrizzleMemberRenewalFlagsRepoWithTenant(CTX);
    await repo.listAtRiskWidgetMembers(rec.db as never, T, anyWith({ ...OFF, band: 'critical' }) as never).catch(() => undefined);
    await repo.clearEmailUnverifiedInTenant('member-1').catch(() => undefined);
    expect(rec.statements.length).toBeGreaterThanOrEqual(2);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('renewal escalation tasks', async () => {
    const tx = rec.db;
    rec.statements.length = 0;
    await callEach(makeDrizzleRenewalEscalationTaskRepo(CTX) as never, {
      insertIfAbsent: [tx, ANY],
      findById: [T, 'task-1'],
      list: [T, anyWith(OFF)],
      listOpenForUser: [T, 'user-1'],
      listForCycle: [T, 'cycle-1'],
      listOpenForMemberByType: [T, 'member-1', 'post_termination_payment_review'],
      transitionStatus: [tx, T, 'task-1', anyWith({ from: 'open', to: 'resolved' })],
      reassign: [tx, T, 'task-1', 'user-2'],
      countMatching: [T, anyWith(OFF)],
      listDistinctTaskTypes: [T, { statusFilter: undefined }],
      listForAdminQueue: [T, anyWith(OFF)],
    });
    expect(rec.statements.length).toBeGreaterThanOrEqual(10);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('every hand-written sql block on a tenant table names tenant_id (row-dependent statements included)', () => {
    expect(unfencedRawSql(readFileSync(FLAGS_SRC, 'utf8'), TABLES)).toEqual([]);
    expect(unfencedRawSql(readFileSync(ESCALATION_SRC, 'utf8'), TABLES)).toEqual([]);
  });

  it('every .where( in both sources names tenant_id (row-dependent statements included)', () => {
    // `baseWhere` is the composed at-risk widget filter — fenced, and proven
    // by the call-map case above.
    expect(unfencedWheres(readFileSync(FLAGS_SRC, 'utf8'))).toEqual([
      'baseWhere',
    ]);
    expect(unfencedWheres(readFileSync(ESCALATION_SRC, 'utf8'))).toEqual([]);
  });
});
