/**
 * F9 member-plan source adapter (US4 / T017) — resolves a member's
 * (planId, planYear) via the members PUBLIC BARREL (`drizzleMemberRepo.findById`),
 * no deep/foreign-table import (Constitution Principle III).
 *
 * Lightweight by design: the benefit view only needs the plan identity, so we
 * use the repo's `findById` directly rather than the `getMember` use-case
 * (which also loads contacts + emits a cross-tenant-probe audit row). A
 * `repo.not_found` (including an RLS cross-tenant miss) → null; the use-case
 * maps that to a 404.
 */
import { drizzleMemberRepo, asMemberId } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';
import type {
  MemberPlanIdentity,
  MemberPlanSource,
} from '../../application/ports/source-ports';

export const memberPlanSourceAdapter: MemberPlanSource = {
  async findPlanIdentity(
    ctx: TenantContext,
    memberId: string,
  ): Promise<MemberPlanIdentity | null> {
    const result = await drizzleMemberRepo.findById(ctx, asMemberId(memberId));
    if (!result.ok) {
      if (result.error.code === 'repo.not_found') return null;
      // A real repo failure (not a miss) must not be silently swallowed as
      // "member not found" — surface it so the use-case's catch logs + 500s.
      throw new Error(`member-plan lookup failed: ${result.error.code}`);
    }
    return {
      planId: result.value.planId as string,
      planYear: result.value.planYear,
    };
  },
};
