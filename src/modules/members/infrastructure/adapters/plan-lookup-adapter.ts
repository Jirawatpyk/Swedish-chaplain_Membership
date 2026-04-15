/**
 * PlanLookupPort adapter (B.1 stub; real wiring lands in US3 B.3).
 *
 * Per Constitution Principle III, Members module imports from
 * `@/modules/plans` (barrel) only — never deep paths.
 *
 * B.1 returns permissive bounds so create-member happy-path + basic
 * validation tests run without a full F2 plans composition-root wiring.
 * US3 replaces this with a proper adapter that composes F2's `getPlan`
 * use case + `countAffectedMembers` SC-008 query.
 */

import { ok } from '@/lib/result';
import type { PlanLookupPort } from '../../application/ports/plan-lookup-port';

export const plansBarrelAdapter: PlanLookupPort = {
  async getPlan(ctx, planId, planYear) {
    return ok({
      tenantId: ctx.slug,
      planId,
      planYear,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      // Permissive bounds — domain policies short-circuit when null.
      minTurnoverThb: null,
      maxTurnoverThb: null,
      maxDurationYears: null,
      maxMemberAge: null,
      includesCorporatePlanId: null,
    });
  },

  async countAffectedMembers(ctx, planId, planYear) {
    // B.1 stub — consume params so lint doesn't flag unused vars.
    // US3 will implement the real COUNT query against members table.
    void ctx;
    void planId;
    void planYear;
    return ok({ count: 0 });
  },
};
