/**
 * 130 (D-029) slice 6 — every statement of the contact repo and the F114
 * change-request repo carries a `tenant_id` predicate on each tenant-scoped
 * table it names. `callEach` refuses an unnamed method; the source scan covers
 * statements that only run once an earlier read returns rows (the recording
 * db answers none).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../helpers/tenant-sql-shape';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[], db: null as unknown }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { recordingDb, SHAPE_TENANT } = await import('../../../helpers/tenant-sql-shape');
  const orig = await importOriginal<typeof import('@/lib/db')>();
  const r = recordingDb();
  rec.statements = r.statements;
  rec.db = r.db;
  // D-030: a tx-only method reads its tenant from the tx `runInTenant` bound.
  (orig as { bindTenantTx?: (tx: unknown, slug: string) => void }).bindTenantTx?.(r.db, SHAPE_TENANT);
  return {
    ...orig,
    db: r.db,
    runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(r.db),
  };
});

const {
  SHAPE_TENANT: T,
  anyWith,
  callEach,
  isPureInsert,
  tenantPredicateViolations,
  tenantScopedTables,
  unfencedRawSql,
  unfencedWheres,
} = await import('../../../helpers/tenant-sql-shape');
const { drizzleContactRepo } = await import('@/modules/members/infrastructure/db/drizzle-contact-repo');
const { drizzleChangeRequestRepo } = await import(
  '@/modules/members/infrastructure/db/drizzle-change-request-repo'
);

const TABLES = tenantScopedTables();
const CTX = { slug: T } as never;
const AT = new Date('2026-01-01T00:00:00.000Z');
const PAGE = { cursor: null, limit: 10 };
const QUEUE_OFF = {
  state: undefined,
  outcome: undefined,
  memberId: undefined,
  submitterUserId: undefined,
  from: undefined,
  to: undefined,
};
const CONTACT_SRC = 'src/modules/members/infrastructure/db/drizzle-contact-repo.ts';
const CHANGE_REQUEST_SRC = 'src/modules/members/infrastructure/db/drizzle-change-request-repo.ts';

function violationsOf(statements: readonly RecordedStatement[]): string[] {
  const checked = statements.filter((s) => !isPureInsert(s.sql));
  // Positive control: every read/update names a tenant table the parse sees.
  const reads = checked.filter((s) => !s.sql.trimStart().toLowerCase().startsWith('insert'));
  expect(reads.filter((s) => tenantPredicateViolations(s, TABLES).refs.length === 0).map((s) => s.sql.slice(0, 80))).toEqual([]);
  return checked.flatMap((s) =>
    tenantPredicateViolations(s, TABLES).violations.map((v) => `${v} :: ${s.sql.slice(0, 90)}`),
  );
}

describe('contact + change-request repos — tenant predicate on every statement (130 s6)', () => {
  it('contacts', async () => {
    const tx = rec.db;
    rec.statements.length = 0;
    await callEach(drizzleContactRepo as never, {
      listByMember: [CTX, 'member-1', { includeRemoved: undefined }],
      findById: [CTX, 'contact-1'],
      findByEmail: [CTX, 'a@example.com'],
      addInTx: [tx, anyWith({ tenantId: T, email: 'a@example.com', dateOfBirth: null })],
      updateInTx: [tx, 'contact-1', { firstName: 'A' }],
      listByMemberInTx: [tx, 'member-1'],
      removeInTx: [tx, 'contact-1'],
      designatePrimaryInTx: [tx, 'member-1', 'contact-1'],
      linkUserInTx: [tx, 'contact-1', 'user-1'],
      listLinkedUserIdsForMemberInTx: [tx, 'member-1'],
      listAllLinkedUserIdsForMemberInTx: [tx, 'member-1'],
      markInviteBouncedInTx: [tx, 'contact-1', AT],
      clearInviteBouncedInTx: [tx, 'contact-1'],
      setMarketingOptOutInTx: [tx, 'contact-1', { kind: 'off', actor: 'staff', at: AT, byUserId: 'user-1' }],
      listEmailsForMemberInTx: [tx, 'member-1'],
      listLiveEmailsForMemberInTx: [tx, 'member-1'],
      listTombstoneEmailsForMemberInTx: [tx, 'member-1'],
      scrubPiiForMemberInTx: [tx, 'member-1', { erasedAt: AT }],
      updateEmailInTx: [tx, CTX, 'contact-1', 'b@example.com'],
      promotePrimaryInTx: [tx, 'member-1', 'contact-2'],
      findMarketingOptedOutEmailLowers: [CTX, ['a@example.com']],
    });
    expect(rec.statements.length).toBeGreaterThanOrEqual(24);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('contacts — listByMember with removed contacts included', async () => {
    rec.statements.length = 0;
    await drizzleContactRepo.listByMember(CTX, 'member-1' as never, { includeRemoved: true });
    expect(rec.statements.length).toBe(1);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('change requests', async () => {
    const tx = rec.db;
    rec.statements.length = 0;
    await callEach(drizzleChangeRequestRepo as never, {
      insertInTx: [tx, anyWith({ tenantId: T, fields: [], submittedAt: AT, staffNotifiedAt: null })],
      findByIdInTx: [tx, 'cr-1'],
      findById: [CTX, 'cr-1'],
      findListRowById: [CTX, 'cr-1'],
      findPendingBySubmitterInTx: [tx, 'user-1'],
      withdrawInTx: [tx, 'cr-1', { reason: 'self', withdrawnAt: AT, replacedByRequestId: null }],
      findPendingBySubmitter: [CTX, 'user-1'],
      decideInTx: [tx, 'cr-1', anyWith({ fields: [], decidedAt: AT, note: null })],
      acknowledgeInTx: [tx, 'cr-1', AT],
      countSubmittedSince: [tx, 'user-1', AT],
      listQueue: [CTX, QUEUE_OFF, PAGE],
      listByMember: [CTX, 'member-1', PAGE],
      listVisibleToUser: [CTX, 'user-1', 'member-1', { ...PAGE, state: undefined }],
      pendingStats: [CTX],
    });
    expect(rec.statements.length).toBeGreaterThanOrEqual(12);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('change requests — every queue filter on, a cursor, a state-filtered visible list', async () => {
    rec.statements.length = 0;
    const cursor = { submittedAt: AT, id: 'cr-0' };
    await drizzleChangeRequestRepo.listQueue(
      CTX,
      { state: 'decided', outcome: 'approved', memberId: 'member-1', submitterUserId: 'user-1', from: AT, to: AT } as never,
      { cursor, limit: 10 } as never,
    );
    await drizzleChangeRequestRepo.listVisibleToUser(CTX, 'user-1' as never, 'member-1' as never, {
      cursor,
      limit: 10,
      state: 'pending',
    } as never);
    expect(rec.statements.length).toBe(2);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('every hand-written sql block on a tenant table names tenant_id (row-dependent statements included)', () => {
    expect(unfencedRawSql(readFileSync(CONTACT_SRC, 'utf8'), TABLES)).toEqual([]);
    expect(unfencedRawSql(readFileSync(CHANGE_REQUEST_SRC, 'utf8'), TABLES)).toEqual([]);
  });

  it('every .where( in both sources names tenant_id (row-dependent statements included)', () => {
    expect(unfencedWheres(readFileSync(CONTACT_SRC, 'utf8'))).toEqual([]);
    expect(unfencedWheres(readFileSync(CHANGE_REQUEST_SRC, 'utf8'))).toEqual([]);
  });
});
