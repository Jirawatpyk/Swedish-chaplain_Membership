/**
 * Spec 122 PR C (/code-review) — the shared acknowledgement read now serves
 * two surfaces (the portal banner and the compose page). Its statement keeps
 * a bound `tenant_id` predicate on `members` (D-029), and it runs inside
 * `runInTenant` (RLS+FORCE), so neither wall can be dropped silently.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../helpers/tenant-sql-shape';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[], tenants: [] as unknown[] }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { recordingDb } = await import('../../../helpers/tenant-sql-shape');
  const r = recordingDb();
  rec.statements = r.statements;
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    db: r.db,
    runInTenant: async (ctx: unknown, fn: (tx: unknown) => unknown) => {
      rec.tenants.push(ctx);
      return fn(r.db);
    },
  };
});

const { SHAPE_TENANT, tenantPredicateViolations, tenantScopedTables } = await import(
  '../../../helpers/tenant-sql-shape'
);
const { readBroadcastsAcknowledgedAt } = await import(
  '@/app/(member)/portal/_components/broadcasts-acknowledgement'
);

describe('readBroadcastsAcknowledgedAt — tenant predicate and runInTenant', () => {
  it('reads members with a bound tenant_id, inside runInTenant', async () => {
    await readBroadcastsAcknowledgedAt({ slug: SHAPE_TENANT } as never, 'member-1');
    expect(rec.statements).toHaveLength(1);
    const check = tenantPredicateViolations(rec.statements[0]!, tenantScopedTables());
    // Positive control: the parse saw the tenant-scoped table.
    expect(check.tables.has('members')).toBe(true);
    expect(check.violations).toEqual([]);
    expect(rec.tenants).toEqual([expect.objectContaining({ slug: SHAPE_TENANT })]);
  });
});
