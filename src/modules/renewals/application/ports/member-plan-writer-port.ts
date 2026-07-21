/**
 * Plan-change -> billing remediation (Package B1) — F8 → F3 member-plan WRITE
 * port. The read-side sibling is `member-plan-lookup-port.ts`.
 *
 * Two renewals paths must persist a member's new plan to `members.plan_id`
 * (+ `members.plan_year`) so Package A's next-cycle seed (which now reads
 * `members.plan_id`) follows the change instead of reverting one cycle later:
 *   - `applyPendingTierUpgradeInTx` — flips the member to a tier-upgrade
 *     suggestion's target plan when the upgrade applies at renewal.
 *   - `confirmRenewal` — persists the member's own portal plan pick.
 *
 * WHY a renewals-owned port (not a direct F3 barrel call from the use-case):
 * Application orchestrates its OWN ports (Constitution Principle III). The
 * adapter (`member-plan-writer-drizzle.ts`) delegates to the SAME F3 repo
 * method `change-plan.ts` uses (`f3DrizzleMemberRepo.updateFieldsInTx`), so
 * the two plan-flip surfaces write the identical `(plan_id, plan_year)` pair.
 *
 * `plan_year` is NOT optional. `members.(plan_id, plan_year)` is a COMPOSITE
 * FK to `membership_plans (tenant_id, plan_id, plan_year)` (enforced at the
 * migration layer — see `schema-members.ts` "Plan binding"), and it also
 * drives the members-directory / timeline plan-name join and the plan
 * soft-delete member count. Writing `plan_id` with a stale `plan_year` would
 * either violate that FK (rolling back the enclosing F4-paid tx — catastrophic)
 * or silently break plan-name resolution. Callers derive `planYear` from the
 * relevant cycle's fiscal year (the SAME year they resolved the plan under),
 * so the pair always resolves to a real catalogue row.
 *
 * In-tx by design: the write participates in the caller's `runInTenant` tx
 * (tenant scope via the inherited GUC + RLS, NEVER a WHERE clause — same
 * precedent as `MemberPlanLookupPort`) so the flip commits atomically with the
 * cycle/suggestion state + audit. THREADS the caller's `tx` — a global-`db`
 * write would silently bypass RLS (the recurring tenant-isolation gotcha).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';

export interface MemberPlanWriterPort {
  /**
   * Persist `(planId, planYear)` onto `members` inside the caller's tx.
   * Returns the written pair on success. Returns `null` when the member does
   * not exist in the current tenant (absent OR cross-tenant — RLS makes both
   * indistinguishable, which is the desired no-oracle behaviour). THROWS on
   * any other repo/infra error so the caller's tx rolls back rather than
   * silently treating an infra failure as a successful flip.
   */
  writePlanIdInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
    planId: string,
    planYear: number,
  ): Promise<{ readonly planId: string; readonly planYear: number } | null>;
}
