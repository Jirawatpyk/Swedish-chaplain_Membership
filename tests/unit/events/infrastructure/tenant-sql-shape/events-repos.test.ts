/**
 * 130 (D-029) slice 7 — the csv_import_records repo and the attendances read
 * carry a `tenant_id` predicate on each tenant-scoped table they name. The csv
 * admin repo runs as the owner role across tenants by design (the blob-expiry
 * cron, the cross-tenant id lookup) — its two reads are pinned as the only
 * exemptions.
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
  unfencedWheres,
} = await import('../../../../helpers/tenant-sql-shape');
const { makeDrizzleCsvImportRecordsRepository } = await import(
  '@/modules/events/infrastructure/drizzle-csv-import-records-repo'
);
const { drizzleEventAttendeesQueryStrict } = await import(
  '@/modules/events/infrastructure/drizzle-event-attendees-by-member'
);

const TABLES = tenantScopedTables();
const DAY = new Date('2026-01-01T00:00:00.000Z');
const CSV_SRC = 'src/modules/events/infrastructure/drizzle-csv-import-records-repo.ts';
const ATTENDEES_SRC = 'src/modules/events/infrastructure/drizzle-event-attendees-by-member.ts';

function violationsOf(statements: readonly RecordedStatement[]): string[] {
  const checked = statements.filter((s) => !isPureInsert(s.sql));
  // Positive control: every read/update names a tenant table the parse sees.
  expect(checked.filter((s) => tenantPredicateViolations(s, TABLES).refs.length === 0).map((s) => s.sql.slice(0, 80))).toEqual([]);
  return checked.flatMap((s) =>
    tenantPredicateViolations(s, TABLES).violations.map((v) => `${v} :: ${s.sql.slice(0, 90)}`),
  );
}

describe('events repos — tenant predicate on every statement (130 s7)', () => {
  it('csv import records', async () => {
    rec.statements.length = 0;
    await callEach(makeDrizzleCsvImportRecordsRepository(rec.db as never) as never, {
      insert: [ANY],
      updateOutcome: [ANY],
      setErrorCsvBlob: [anyWith({ errorCsvExpiresAt: DAY })],
      findByFingerprintAcrossEvents: [anyWith({ since: DAY })],
      listByTenant: [anyWith({ perPage: 10, page: 1, eventIdFilter: undefined, actorUserIdFilter: undefined })],
      findById: [T, 'record-1'],
      clearErrorCsvBlob: [T, 'record-1'],
    });
    expect(rec.statements.filter((s) => !isPureInsert(s.sql)).length).toBeGreaterThanOrEqual(6);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('member attendances', async () => {
    rec.statements.length = 0;
    await drizzleEventAttendeesQueryStrict.list(
      anyWith({ tenantId: T, memberId: 'member-1', since: DAY, until: undefined, limit: 10 }) as never,
    );
    expect(rec.statements.length).toBe(1);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('every .where( names tenant_id, bar the admin repo cross-tenant reads', () => {
    // `whereClause` is listByTenant's composed filter list — it starts with
    // the tenant predicate, proven by the call-map case above.
    expect(unfencedWheres(readFileSync(CSV_SRC, 'utf8'))).toEqual([
      'and( isNotNull(csvImportRecords.errorCsvBlobUrl), isNotNull(csvImportRecords.errorCsvExpiresAt), lt(csvImportRecords.errorCsvExpiresAt, cutoff), ),',
      'eq(csvImportRecords.recordId, recordId)',
      'whereClause',
      'whereClause',
    ]);
    expect(unfencedWheres(readFileSync(ATTENDEES_SRC, 'utf8'))).toEqual([]);
  });
});
