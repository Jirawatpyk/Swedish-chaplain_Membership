/**
 * F8-completion Slice 3 · Task 3.1 — F8 → F3 member-plan lookup adapter.
 *
 * Implements `MemberPlanLookupPort` by delegating to F3's
 * `f3DrizzleMemberRepo.findByIdInTx` (barrel-only cross-module import per
 * Constitution Principle III). Threads the caller's tx so the read
 * participates in the surrounding `runInTenant` transaction (tenant scope
 * via the inherited GUC + RLS). A `repo.not_found` (absent OR cross-tenant
 * — RLS filters it) maps to `null`; any other repo error throws so the
 * use-case's tx rolls back rather than silently treating an infra failure
 * as "member not found".
 *
 * Pure Infrastructure — only the F3 members barrel + the F8 port type
 * (Constitution Principle III).
 */
import { f3DrizzleMemberRepo, asMemberId } from '@/modules/members';
import type { MemberPlanLookupPort } from '../../application/ports/member-plan-lookup-port';

export const memberPlanLookupDrizzle: MemberPlanLookupPort = {
  async loadMemberPlanInTx(tx, _tenantId, memberId) {
    const result = await f3DrizzleMemberRepo.findByIdInTx(
      tx,
      asMemberId(memberId),
    );
    if (!result.ok) {
      if (result.error.code === 'repo.not_found') {
        return null;
      }
      throw new Error(
        `memberPlanLookupDrizzle: member lookup failed (${result.error.code}) for member ${memberId}`,
      );
    }
    return { planId: result.value.planId };
  },
};
