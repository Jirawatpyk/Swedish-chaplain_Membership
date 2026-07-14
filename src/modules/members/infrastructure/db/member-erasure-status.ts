/**
 * COMP-1 US3-A — narrow read for the member-detail ErasedBanner.
 *
 * Returns `members.erased_at` plus whether the `member_erased` completion
 * proof exists, in ONE round-trip (single-row SELECT + EXISTS subquery). The
 * page uses `erasedAt !== null` to hide write affordances + render the banner,
 * and `completed` to decide the banner's "completion pending" line.
 *
 * Free function (NOT a MemberRepo method) — the established narrow-read pattern
 * (countActiveMembersOnPlan / memberVatRegistrantByIdsInTx) avoids widening the
 * MemberRepo interface and its many test stubs.
 *
 * RLS: `members` is RLS-scoped, so `m.member_id = <id>` inside runInTenant
 * returns only this tenant's row. `audit_log` uses a PERMISSIVE policy
 * (tenant_id IS NULL OR = current_setting), so the explicit
 * `al.tenant_id = <slug>` filter in the EXISTS is load-bearing — without it a
 * tenant-NULL or foreign row could satisfy the subquery. The string-literal
 * `event_type = 'member_erased'` is coerced to the `audit_event_type` enum by
 * Postgres, and `payload->>'member_id'` is the EXACT snake_case key the
 * `audit.recordInTx` emit in `erase-member.ts` writes (mirrors
 * `findStuckErasuresInTx`). Threads the runInTenant tx (the RLS gotcha), never
 * the global db.
 *
 * FAIL-CLOSED BY DESIGN — no try/catch. A read failure must REJECT the page
 * render (→ the member-detail segment `error.tsx` boundary), NOT default to a
 * value. NEVER add a `catch { return { erasedAt: null, completed: false } }`:
 * defaulting to "not erased" would silently re-expose the Edit/Archive/Erase
 * write affordances on a member that IS erased — an Art.17/§33 control bypass.
 */
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';

export type MemberErasureStatus = {
  readonly erasedAt: Date | null;
  /** true ⇔ a `member_erased` completion audit exists for this member. */
  readonly completed: boolean;
};

export async function getMemberErasureStatus(
  ctx: TenantContext,
  memberId: MemberId,
): Promise<MemberErasureStatus> {
  const rows = (await runInTenant(ctx, (tx) =>
    tx.execute(sql`
      SELECT
        m.erased_at AS erased_at,
        EXISTS (
          SELECT 1 FROM audit_log al
          WHERE al.tenant_id = ${ctx.slug}
            AND al.event_type = 'member_erased'
            AND al.payload->>'member_id' = m.member_id::text
        ) AS completed
      FROM members m
      WHERE m.member_id = ${memberId}
      LIMIT 1
    `),
  )) as unknown as Array<{
    erased_at: Date | string | null;
    completed: boolean | 't' | 'f';
  }>;

  const row = rows[0];
  if (row === undefined) return { erasedAt: null, completed: false };

  const erasedAt =
    row.erased_at === null
      ? null
      : row.erased_at instanceof Date
        ? row.erased_at
        : new Date(row.erased_at);
  return {
    erasedAt,
    completed: row.completed === true || row.completed === 't',
  };
}
