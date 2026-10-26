/**
 * Spec 131 (D-029) — every statement of `drizzleBroadcastImagesRepo` carries
 * its own `tenant_id` predicate on each tenant-scoped table it names, so the
 * repo stays isolated if RLS is ever bypassed. `callEach` refuses a method
 * the gate does not call, so a new method (spec 131's `markDeletedById` and
 * `listUnused`) cannot ship unchecked.
 *
 * `lockContentHash` and `setStatementTimeout` touch no table; `record` is a
 * pure insert (tenant in VALUES). They are called, and skipped by the filter.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../helpers/tenant-sql-shape';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[] }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { recordingDb } = await import('../../../helpers/tenant-sql-shape');
  const r = recordingDb();
  rec.statements = r.statements;
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    db: r.db,
    runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(r.db),
    withTenantTxOrOpen: async (_t: unknown, tx: unknown, fn: (tx: unknown) => unknown) => fn(tx ?? r.db),
  };
});

const { SHAPE_TENANT, callEach, isPureInsert, tenantPredicateViolations, tenantScopedTables } =
  await import('../../../helpers/tenant-sql-shape');
const { drizzleBroadcastImagesRepo } = await import(
  '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-images-repo'
);

const TABLES = tenantScopedTables();
const OWNER = { kind: 'broadcast', id: '11111111-1111-1111-1111-111111111111' } as const;
const AT = new Date('2026-10-26T00:00:00Z');

describe('drizzleBroadcastImagesRepo — D-029 tenant predicates', () => {
  it('every statement fences each tenant-scoped table it names', async () => {
    const tx = (await import('@/lib/db')).db;
    rec.statements.length = 0;
    await callEach(drizzleBroadcastImagesRepo as never, {
      withTx: [SHAPE_TENANT, async () => undefined],
      record: [SHAPE_TENANT, { ownerKind: 'broadcast', ownerId: OWNER.id, contentHash: 'h', blobUrl: 'u', blobKey: 'k', mimeType: 'image/png', byteSize: 1, uploadedByUserId: 'u-1' }, tx],
      listByOwner: [SHAPE_TENANT, OWNER, tx],
      markDeletedByOwner: [SHAPE_TENANT, OWNER, AT, tx],
      markDeletedById: [SHAPE_TENANT, OWNER, '22222222-2222-2222-2222-222222222222', AT, tx],
      markDeletedByOwners: [SHAPE_TENANT, 'broadcast', [OWNER.id], AT, tx],
      markDeletedForMember: [SHAPE_TENANT, '33333333-3333-3333-3333-333333333333', AT, tx],
      listByMember: [SHAPE_TENANT, '33333333-3333-3333-3333-333333333333', 10, tx],
      listMarked: [SHAPE_TENANT, 10, tx],
      listOrphaned: [SHAPE_TENANT, 10, tx],
      listUnused: [SHAPE_TENANT, 10, tx],
      countLiveByContentHash: [SHAPE_TENANT, 'h', tx, 'img-x'],
      lockContentHash: [SHAPE_TENANT, 'h', tx],
      isBlobReferencedByContent: [SHAPE_TENANT, 'https://x/y.png', tx],
      restoreLive: [SHAPE_TENANT, 'img-x', tx],
      remove: [SHAPE_TENANT, 'img-x', tx],
      setStatementTimeout: [5000, tx],
    });
    const checked = rec.statements.filter(
      (s) => !isPureInsert(s.sql) && tenantPredicateViolations(s, TABLES).refs.length > 0,
    );
    // Positive control: one per table-reading method (13 of the 17 above).
    expect(checked.length).toBeGreaterThanOrEqual(13);
    const violations = checked.flatMap((s) =>
      tenantPredicateViolations(s, TABLES).violations.map((v) => `${v} :: ${s.sql.replace(/\s+/g, ' ').slice(0, 120)}`),
    );
    expect(violations).toEqual([]);
  });
});
