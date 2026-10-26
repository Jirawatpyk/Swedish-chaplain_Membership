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
const { adminQueueListQuery, makeDrizzleBroadcastsRepo } = await import(
  '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo'
);
const { drizzle } = await import('drizzle-orm/pg-proxy');

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

  it('the custom-recipient redaction UPDATE binds both of its broadcasts refs', async () => {
    // A proxy db that answers the method's tenant-bound probe; the scan below
    // cannot see this statement's predicates (nested sql.join fragments).
    const statements: RecordedStatement[] = [];
    const db = drizzle(async (sql, params) => {
      statements.push({ sql, params });
      return { rows: /current_setting/.test(sql) ? [{ current_tenant: T }] : [] };
    });
    const repo = makeDrizzleBroadcastsRepo(T as never);
    await repo.redactMemberEmailFromCustomRecipientsInTx(db as never, T as never, ['a@example.com']);
    const update = statements.find((s) => /^\s*update broadcasts/i.test(s.sql));
    expect(update).toBeDefined();
    expect([...tenantPredicateViolations(update!, TABLES).tables]).toEqual(['broadcasts']);
    // `FROM broadcasts b2, LATERAL unnest(…)` is a comma join to a function,
    // not a table; every broadcasts ref (`b`, `b2`) is bound.
    expect(tenantPredicateViolations(update!, TABLES).violations).toEqual(['comma join after a table reference']);
  });

  it('listForMemberPaginated filters by its tenant-led baseWhere', () => {
    expect(readFileSync(SRC, 'utf8').match(/const baseWhere = and\(\s*eq\(broadcasts\.tenantId, tenantIdArg\)/g)?.length).toBe(1);
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
