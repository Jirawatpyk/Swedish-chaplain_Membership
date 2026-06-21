/**
 * COMP-1 US3-D FIX-1 — the PERMISSIVE-RLS no-unbounded-read structural proof.
 *
 * The single regression wall for the tenant-NULL `user_erased` leak. The
 * `erasureEvidenceReadAdapter` DELIBERATELY removes the app-layer `tenant_id =
 * ctx.slug` wall for ONE event (`user_erased`), bounding it instead by
 * `target_user_id = ANY(<member's own linked users>)`. If the member has NO
 * linked login the bound set is empty — and the arm MUST be OMITTED ENTIRELY
 * (no `tenant_id IS NULL AND event_type='user_erased'` SQL is even built), so
 * the query can never surface another tenant's identity-erasure events.
 *
 * This asserts the structural omission directly off the built `WHERE` via
 * Drizzle `.toSQL()`. plan-review M-1 + R-3: `'user_erased'` is a BOUND PARAM
 * (not a literal in the SQL text), so a text-only grep would MISS it — assert
 * BOTH `.params` (no `'user_erased'`, no linked-user id) AND `.sql` (no second
 * `is null` / `target_user_id` Arm-B fragment) for the empty case, and the
 * POSITIVE CONTROL (non-empty → all three present).
 */
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asTenantContext } from '@/modules/tenants';
import { buildErasureEvidenceWhere } from '@/modules/auth/infrastructure/db/erasure-evidence-repo';

const ctx = asTenantContext('test-tenant-fix1');
const MEMBER_ID = '11111111-1111-1111-1111-111111111111';
const LINKED_USER_ID = '22222222-2222-2222-2222-222222222222';

/**
 * Render the built WHERE to `{ sql, params }`. The SQL text is sliced to the
 * predicate that FOLLOWS the literal `where ` so the SELECT projection (which
 * always lists every column name, incl. `target_user_id`) cannot false-positive
 * the "no Arm-B fragment" assertions — only the WHERE clause is inspected.
 */
function renderWhere(memberLinkedUserIds: readonly string[]) {
  const where = buildErasureEvidenceWhere(ctx, MEMBER_ID, memberLinkedUserIds);
  const built = db.select().from(auditLog).where(where).toSQL();
  const whereIdx = built.sql.toLowerCase().lastIndexOf(' where ');
  const whereClause = whereIdx === -1 ? built.sql : built.sql.slice(whereIdx);
  return { sql: whereClause, params: built.params, fullSql: built.sql };
}

describe('buildErasureEvidenceWhere — FIX-1 no-unbounded-tenant-NULL read', () => {
  it('EMPTY linked-users: builds NO user_erased / tenant-NULL Arm-B (params + sql)', () => {
    const { sql, params } = renderWhere([]);

    // `'user_erased'` is bound as a param — assert it is absent from params.
    expect(params).not.toContain('user_erased');
    // The bound member-id (Arm A) IS present; the linked-user id (Arm B) is NOT.
    expect(params).toContain(MEMBER_ID);
    expect(params).not.toContain(LINKED_USER_ID);

    // No Arm-B SQL fragment: no `tenant_id IS NULL` and no `target_user_id = ANY`.
    const lower = sql.toLowerCase();
    expect(lower).not.toContain('is null');
    expect(lower).not.toContain('target_user_id');
    // Belt-and-suspenders: the tenant-NULL union arm is not even an OR.
    expect(lower).not.toContain(' or ');
  });

  it('NON-EMPTY linked-users (positive control): builds the user_erased Arm-B', () => {
    const { sql, params } = renderWhere([LINKED_USER_ID]);

    // Arm B IS built — `'user_erased'` is bound + the linked-user id is bound.
    expect(params).toContain('user_erased');
    expect(params).toContain(LINKED_USER_ID);
    // Arm A's member-id is still bound.
    expect(params).toContain(MEMBER_ID);

    // The Arm-B SQL fragment is present: the tenant-NULL test + the ANY bind.
    const lower = sql.toLowerCase();
    expect(lower).toContain('is null');
    expect(lower).toContain('target_user_id');
    expect(lower).toContain('= any');
    // The two arms are OR-ed together.
    expect(lower).toContain(' or ');
  });
});
