/**
 * Spec 140 s2c (D-029) — every statement of `makeDrizzleBroadcastOrphansRepo`
 * fences each tenant-scoped table it names, the NOT EXISTS subquery's
 * `broadcasts` reference included, and every method checks the bound tenant
 * first (`assertTenantBoundTx`). `callEach` refuses a method the gate does not
 * call, so a new one cannot ship unchecked.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../../helpers/tenant-sql-shape';

const T = 'tenant-shape';
const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[] }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { drizzle } = await import('drizzle-orm/pg-proxy');
  // Answers the tenant probe, records everything, returns no rows otherwise.
  const db = drizzle(async (sql, params) => {
    rec.statements.push({ sql, params });
    return { rows: /current_setting/.test(sql) ? [{ current_tenant: 'tenant-shape' }] : [] };
  });
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    db,
    runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db),
  };
});

const { callEach, isPureInsert, tenantPredicateViolations, tenantScopedTables } = await import(
  '../../../../helpers/tenant-sql-shape'
);
const { makeDrizzleBroadcastOrphansRepo } = await import(
  '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-orphans-repo'
);

const TABLES = tenantScopedTables();
const ID = '11111111-1111-1111-1111-111111111111';

describe('broadcast orphans repo — D-029 tenant predicates', () => {
  it('every statement fences each tenant-scoped table it names, and every method probes the bound tenant', async () => {
    rec.statements.length = 0;
    const repo = makeDrizzleBroadcastOrphansRepo(T);
    await callEach(repo as never, {
      recordOrphanedResendId: [{ broadcastId: ID, requestedByMemberId: ID, resourceType: 'broadcast', resourceId: 'rb-1', reason: 'attach_lost' }],
      listDrainableOrphans: [20],
      listMemberOrphans: [ID],
      listUnsettledAudienceOrphans: [20],
      settleOrphan: [ID, 'deleted'],
      pruneOrphans: [new Date('2026-01-01T00:00:00Z')],
    });
    const probes = rec.statements.filter((s) => /current_setting\('app\.current_tenant'/.test(s.sql));
    expect(probes).toHaveLength(6);
    const checked = rec.statements.filter(
      (s) => !isPureInsert(s.sql) && tenantPredicateViolations(s, TABLES).refs.length > 0,
    );
    // Positive control: the three reads and the settle UPDATE reach the
    // parser (the INSERT is pure, the prune names no table), and each read
    // names BOTH tables (the NOT EXISTS subquery).
    expect(checked).toHaveLength(4);
    const readTables = checked
      .filter((s) => /^\s*select/i.test(s.sql))
      .map((s) => [...tenantPredicateViolations(s, TABLES).tables].sort().join('+'));
    expect(readTables).toEqual([
      'broadcast_orphaned_resend_ids+broadcasts',
      'broadcast_orphaned_resend_ids+broadcasts',
      'broadcast_orphaned_resend_ids+broadcasts',
    ]);
    const violations = checked.flatMap((s) =>
      tenantPredicateViolations(s, TABLES).violations.map((v) => `${v} :: ${s.sql.replace(/\s+/g, ' ').slice(0, 160)}`),
    );
    expect(violations).toEqual([]);
    // The prune passes the bound tenant to the SECURITY DEFINER function.
    const prune = rec.statements.find((s) => /prune_orphaned_resend_ids/.test(s.sql));
    expect(prune?.params).toContain(T);
  });
});
