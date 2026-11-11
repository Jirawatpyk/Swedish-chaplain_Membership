/**
 * #82 — the E-Blast queue's member filter lists every member who is not
 * archived (it used to stop at 200 active ones, so an inactive member's
 * E-Blasts could not be filtered), plus the member a `?memberId=` names even
 * when archived, so the filter never reads "All members" while it filters.
 * A `memberId` that is not a UUID is ignored instead of reaching SQL.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../helpers/tenant-sql-shape';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[], db: null as unknown }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { recordingDb } = await import('../../helpers/tenant-sql-shape');
  const r = recordingDb();
  rec.statements = r.statements;
  rec.db = r.db;
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    db: r.db,
    runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(r.db),
  };
});

const { SHAPE_TENANT: T, tenantPredicateViolations, tenantScopedTables } = await import(
  '../../helpers/tenant-sql-shape'
);
const { queueMemberIdParam, readQueueMemberFilterOptions } = await import('@/lib/admin-broadcast-queue');

const ID = '3f2b8c1e-9a4d-4e5f-8b6a-1c2d3e4f5a6b';

describe('E-Blast queue member filter (#82)', () => {
  it('reads every non-archived member plus the selected one, fenced, with no row cap', async () => {
    rec.statements.length = 0;
    await readQueueMemberFilterOptions({ slug: T } as never, ID);
    expect(rec.statements).toHaveLength(1);
    const s = rec.statements[0]!;
    expect(tenantPredicateViolations(s, tenantScopedTables()).violations).toEqual([]);
    expect(s.sql).toMatch(/status\s*<>\s*'archived'/i);
    expect(s.sql).not.toMatch(/limit/i);
    expect(s.params).toContain(ID);
  });

  it('without a selected member, only the non-archived ones', async () => {
    rec.statements.length = 0;
    await readQueueMemberFilterOptions({ slug: T } as never, undefined);
    expect(rec.statements[0]!.sql).not.toMatch(/member_id::text\s*=/i);
  });

  it('a memberId param counts only when it is a UUID', () => {
    expect(queueMemberIdParam(ID)).toBe(ID);
    expect(queueMemberIdParam(ID.toUpperCase())).toBe(ID.toUpperCase());
    expect(queueMemberIdParam('not-a-uuid')).toBeUndefined();
    expect(queueMemberIdParam("x' OR 1=1")).toBeUndefined();
    expect(queueMemberIdParam(undefined)).toBeUndefined();
    expect(queueMemberIdParam(['a'] as never)).toBeUndefined();
  });
});
