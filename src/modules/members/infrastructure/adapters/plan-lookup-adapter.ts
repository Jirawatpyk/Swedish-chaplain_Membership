/**
 * PlanLookupPort adapter — T087 full wiring.
 *
 * Implements two concerns:
 *   1. `getPlan` — fetches plan metadata from the F2 plans module via
 *      `buildPlansDeps(ctx).planRepo.findOne(...)`. Uses the port method
 *      directly rather than the `getPlan` use case because the use case
 *      emits a `plan_not_found` audit event on every miss — appropriate
 *      for request-path lookups but noisy for internal adapter calls
 *      from create/update-member.
 *   2. `countAffectedMembers` — tenant-scoped COUNT over the members
 *      table. Lives HERE (members module) rather than in the F2 plans
 *      module because it queries the members table.
 *
 * Clean Architecture discipline:
 *   - `getPlan` goes through the F2 public barrel (`@/modules/plans`)
 *     and `@/modules/plans/plans-deps`. No deep imports.
 *   - `countAffectedMembers` uses its own Drizzle query on the members
 *     schema (same module → internal import allowed).
 */

import { count, eq, and, or } from 'drizzle-orm';
import { ok, err } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { members } from '../db/schema-members';
import { asPlanSlug, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { asPlanId, asTenantId } from '../../domain/member';
import type {
  PlanLookupPort,
  PlanSummary,
} from '../../application/ports/plan-lookup-port';

export const plansBarrelAdapter: PlanLookupPort = {
  async getPlan(ctx, planId, planYear) {
    try {
      const deps = buildPlansDeps(ctx);
      const plan = await deps.planRepo.findOne(
        ctx,
        asPlanSlug(planId),
        asPlanYear(planYear),
      );
      if (!plan) return err({ code: 'repo.not_found' });

      const summary: PlanSummary = {
        tenantId: asTenantId(plan.tenant_id),
        planId: asPlanId(plan.plan_id),
        planYear: plan.plan_year,
        // JSONB `plan_name` is `{ en: string, th?: string, sv?: string }`.
        // English is the canonical admin display name; tenant-localised
        // lookup can layer on top later via i18n.
        planNameEn: plan.plan_name.en ?? plan.plan_id,
        planCategory: plan.plan_category,
        memberTypeScope: plan.member_type_scope,
        minTurnoverThb: plan.min_turnover_minor_units,
        maxTurnoverThb: plan.max_turnover_minor_units,
        maxDurationYears: plan.max_duration_years,
        maxMemberAge: plan.max_member_age,
        includesCorporatePlanId: plan.includes_corporate_plan_id
          ? asPlanId(plan.includes_corporate_plan_id)
          : null,
      };
      return ok(summary);
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async countAffectedMembers(ctx, planId, planYear) {
    try {
      const rows = await runInTenant(ctx, (tx) =>
        tx
          .select({ value: count() })
          .from(members)
          .where(
            and(
              eq(members.planId, planId),
              eq(members.planYear, planYear),
              or(
                eq(members.status, 'active'),
                eq(members.status, 'inactive'),
              ),
            ),
          ),
      );
      return ok({ count: rows[0]?.value ?? 0 });
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },
};
