/**
 * 130 (D-029) slice 7 — the broadcasts repo needed no change: its composed
 * filter lists start with the tenant predicate and its redaction UPDATE binds
 * `tenant_id` on both refs. The two webhook pre-resolution reads
 * (`findByResendBroadcastIdBypassRls`, `findBroadcastByResendAudienceIdsBypassRls`)
 * run as the owner role before the tenant is known — pinned as the only
 * exemptions, so a new unfenced statement turns this red.
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

const { SHAPE_TENANT: T, tenantPredicateViolations, tenantScopedTables, unfencedRawSql, unfencedWheres } =
  await import('../../../../helpers/tenant-sql-shape');
const { adminQueueListQuery } = await import('@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo');

const TABLES = tenantScopedTables();
const SRC = 'src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts';

describe('broadcasts repo — tenant predicate on every statement (130 s7)', () => {
  it('the admin-queue list with every filter off', async () => {
    rec.statements.length = 0;
    await adminQueueListQuery(rec.db as never, T, { pageSize: 10 } as never);
    expect(rec.statements.length).toBe(1);
    // Positive control: the parse sees the broadcasts ref.
    expect([...tenantPredicateViolations(rec.statements[0]!, TABLES).tables]).toEqual(['broadcasts']);
    expect(tenantPredicateViolations(rec.statements[0]!, TABLES).violations).toEqual([]);
  });

  it('every .where( names tenant_id, bar the composed lists and the two pre-resolution reads', () => {
    // `and(...conditions)` (adminQueueListQuery) and `baseWhere`
    // (listForMemberPaginated) are composed lists that start with the tenant
    // predicate.
    expect(unfencedWheres(readFileSync(SRC, 'utf8'))).toEqual([
      'and(...conditions)',
      'baseWhere',
      'baseWhere',
      'eq(broadcasts.resendBroadcastId, resendBroadcastId)',
      'inArray(broadcasts.resendAudienceId, [...resendAudienceIds])',
    ]);
  });

  it('every hand-written sql block on a tenant table names tenant_id', () => {
    // The redaction UPDATE nests `sql` fragments inside `sql.join`, so the
    // scan's body stops at the first nested backtick — before its two
    // `tenant_id` predicates (read the method: both `b` and `b2` are bound).
    expect(unfencedRawSql(readFileSync(SRC, 'utf8'), TABLES)).toEqual([
      'UPDATE broadcasts b SET custom_recipient_emails = sub.arr FROM ( SELECT b2.broadcast_id, array_agg( CASE WHEN lower(elem',
    ]);
  });
});
