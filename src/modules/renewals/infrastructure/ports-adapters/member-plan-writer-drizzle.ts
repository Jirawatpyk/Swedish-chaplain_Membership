/**
 * Plan-change -> billing remediation (Package B1) — F8 → F3 member-plan WRITE
 * adapter. Read-side sibling: `member-plan-lookup-drizzle.ts`.
 *
 * Implements `MemberPlanWriterPort` by delegating to the SAME F3 repo method
 * `change-plan.ts` uses to flip a member's plan binding
 * (`f3DrizzleMemberRepo.updateFieldsInTx(tx, memberId, { planId, planYear })`),
 * via the F3 members barrel only (Constitution Principle III). Threads the
 * caller's `tx` so the write participates in the surrounding `runInTenant`
 * transaction (tenant scope via the inherited GUC + RLS — a global-`db` write
 * would silently bypass RLS). A `repo.not_found` (absent OR cross-tenant — RLS
 * filters it) maps to `null`; any other repo error throws so the caller's tx
 * rolls back rather than silently treating an infra failure as a flip.
 *
 * Pure Infrastructure — only the F3 members barrel + the F8 port type
 * (Constitution Principle III).
 */
import { f3DrizzleMemberRepo, asMemberId, asPlanId } from '@/modules/members';
import type { MemberPlanWriterPort } from '../../application/ports/member-plan-writer-port';

export const memberPlanWriterDrizzle: MemberPlanWriterPort = {
  async writePlanIdInTx(tx, _tenantId, memberId, planId, planYear) {
    // `MemberPatch.planId` is the branded `PlanId`; brand at the boundary
    // (mirrors change-plan.ts, which passes an already-branded `PlanId`).
    const result = await f3DrizzleMemberRepo.updateFieldsInTx(
      tx,
      asMemberId(memberId),
      { planId: asPlanId(planId), planYear },
    );
    if (!result.ok) {
      if (result.error.code === 'repo.not_found') {
        return null;
      }
      throw new Error(
        `memberPlanWriterDrizzle: member plan write failed (${result.error.code}) for member ${memberId}`,
      );
    }
    return { planId: result.value.planId, planYear: result.value.planYear };
  },
};
