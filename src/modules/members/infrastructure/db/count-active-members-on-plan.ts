/**
 * Post-ship R6 C1 + D1 — Count F3 members attached to a given F2 plan.
 *
 * Backs the F2 `MemberAttachmentChecker` port (`src/modules/plans/
 * application/ports.ts:211-225`) which enforces FR-010: a membership
 * plan with active or inactive members cannot be soft-deleted (admins
 * must move members to another plan first).
 *
 * F2 consumes this via the public `@/modules/plans` ↔ `@/modules/members`
 * cross-module barrel composition (Constitution Principle III) — F2's
 * Infrastructure adapter (`drizzle-member-attachment-checker.ts`)
 * imports this free function and adapts the return shape to the F2
 * port contract (`Promise<number>`).
 *
 * Status filter mirrors F3's existing `plansBarrelAdapter.countAffectedMembers`
 * (`infrastructure/adapters/plan-lookup-adapter.ts:79-101`) — both `active`
 * and `inactive` members are counted because both represent "members
 * still on this plan" for FR-010 purposes; only `archived` rows are
 * excluded (they're tombstoned).
 *
 * INFRASTRUCTURE layer: this is a raw Drizzle query (imports `drizzle-orm`
 * operators + the `members` schema table + `runInTenant`). It lived under
 * `application/use-cases/` until the go-live audit (S1-P0-3) flagged the
 * Principle III violation — application MUST NOT import an ORM or schema
 * VALUES. It is genuinely an Infrastructure query (no domain logic), so it
 * moved here and is re-exported through the members barrel unchanged.
 */
import { and, count, eq, isNull, or } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { members } from './schema-members';

/**
 * Count active + inactive F3 members attached to (tenant, planId, planYear).
 *
 * @param ctx F3 tenant context (resolved at composition root).
 * @param planId F2 plan_id slug — passed through as plain string; F2
 *   branding (`PlanSlug`) is not imported here to avoid a cross-module
 *   Domain dependency.
 * @param planYear F2 plan_year as plain integer.
 * @returns count of `members` rows whose status is `active` OR
 *   `inactive` (archived rows are tombstoned and excluded).
 */
export async function countActiveMembersOnPlan(
  ctx: TenantContext,
  planId: string,
  planYear: number,
): Promise<number> {
  const rows = await runInTenant(ctx, (tx) =>
    tx
      .select({ value: count() })
      .from(members)
      .where(
        and(
          eq(members.planId, planId),
          eq(members.planYear, planYear),
          or(eq(members.status, 'active'), eq(members.status, 'inactive')),
          // COMP-1 H4 — exclude erased tombstones from the FR-010 plan-soft-delete guard
          isNull(members.erasedAt),
        ),
      ),
  );
  return Number(rows[0]?.value ?? 0);
}

/**
 * W0-02 — Tx-bound variant: count active + inactive F3 members attached
 * to (planId, planYear) INSIDE an existing `TenantTx`.
 *
 * Unlike `countActiveMembersOnPlan` this does NOT open a new `runInTenant`
 * round-trip. The caller (plan-repo `softDeleteGuarded`) passes the ambient
 * tx so the count executes on the same database connection that holds the
 * `pg_advisory_xact_lock` — guaranteeing the count is within the same
 * serialisation unit as the subsequent soft-delete UPDATE.
 *
 * RLS is already set by `runInTenant` on the surrounding tx — this query
 * does NOT need an explicit `WHERE tenant_id = ?` for safety, but Postgres
 * RLS+FORCE on the `members` table enforces it transparently.
 *
 * Status filter intentionally matches `countActiveMembersOnPlan` exactly:
 * `active` OR `inactive` (archived = tombstoned = excluded).
 */
export async function countActiveMembersOnPlanInTx(
  tx: TenantTx,
  planId: string,
  planYear: number,
): Promise<number> {
  const rows = await tx
    .select({ value: count() })
    .from(members)
    .where(
      and(
        eq(members.planId, planId),
        eq(members.planYear, planYear),
        or(eq(members.status, 'active'), eq(members.status, 'inactive')),
        // COMP-1 H4 — exclude erased tombstones from the FR-010 plan-soft-delete guard
        isNull(members.erasedAt),
      ),
    );
  return Number(rows[0]?.value ?? 0);
}
