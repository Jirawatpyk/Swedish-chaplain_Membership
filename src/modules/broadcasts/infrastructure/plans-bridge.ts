/**
 * T061 — F2 `PlansBridgePort` adapter (F7).
 *
 * Composes F2's `getPlanForMember` use-case (added in Batch C T030) with
 * a thin `MemberPlanIdentityLookup` adapter that calls F3's
 * `drizzleMemberRepo.findById`. F2 → F3 dependency direction is preserved
 * via the `MemberPlanIdentityLookup` port abstraction (F2 does not import
 * F3 directly — the adapter sits at F7 composition root).
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  getPlanForMember,
  type MemberPlanIdentityLookup,
} from '@/modules/plans';
// 2026-05-01 build-fix: `drizzlePlanRepo` was previously re-exported from
// the F2 public barrel, but that pulled postgres + pino into Client
// Components transitively (build broke on Module-not-found `fs`/`net`/
// `tls`/`worker_threads`). The Infrastructure repo is imported directly
// here at the F7 composition root — same escape-hatch pattern documented
// in F5 page.tsx + sweep-stale-pending-refunds + receipt-pdf-reconcile.
import { planRepo as drizzlePlanRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { drizzleMemberRepo, asMemberId } from '@/modules/members';
import type {
  PlansBridgePort,
  MemberPlanSummary as F7MemberPlanSummary,
  PlanLookupError as F7PlanLookupError,
} from '../application/ports/plans-bridge-port';

const memberPlanIdentityLookup: MemberPlanIdentityLookup = {
  async findPlanIdentityByMemberId(ctx, memberId) {
    const result = await drizzleMemberRepo.findById(ctx, asMemberId(memberId));
    if (!result.ok) {
      return result.error.code === 'repo.not_found'
        ? { ok: false, code: 'not_found' as const }
        : { ok: false, code: 'server_error' as const };
    }
    return {
      ok: true,
      value: {
        planId: result.value.planId as string,
        planYear: result.value.planYear,
      },
    };
  },
};

export const plansBridge: PlansBridgePort = {
  async getPlanForMember(
    tenantCtx: TenantContext,
    memberId: string,
  ): Promise<Result<F7MemberPlanSummary, F7PlanLookupError>> {
    const result = await getPlanForMember(
      {
        tenant: tenantCtx,
        planRepo: drizzlePlanRepo,
        memberLookup: memberPlanIdentityLookup,
      },
      memberId,
    );

    if (result.ok) {
      return ok({
        planId: result.value.planId,
        planCode: result.value.planCode,
        eblastPerYear: result.value.eblastPerYear,
      });
    }

    switch (result.error.code) {
      case 'plan_lookup.member_not_found':
        return err({
          kind: 'plan_lookup.member_not_found',
          memberId: result.error.memberId,
        });
      case 'plan_lookup.plan_not_found':
        return err({
          kind: 'plan_lookup.plan_not_found',
          planId: result.error.memberId, // F2 surfaces memberId; we surface planId placeholder
        });
      case 'plan_lookup.member_no_eblast_quota':
        return err({
          kind: 'plan_lookup.member_no_plan',
          memberId: result.error.memberId,
        });
      case 'plan_lookup.server_error':
        // Surface as not_found to caller (closest discriminant in F7's port).
        // submit-broadcast.ts maps both to the FR-002 precondition `a` reject.
        return err({
          kind: 'plan_lookup.member_not_found',
          memberId,
        });
    }
  },
};
