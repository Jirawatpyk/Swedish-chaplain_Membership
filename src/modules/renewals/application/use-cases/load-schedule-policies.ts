/**
 * F8 Phase 4 Wave I1a · T081 — `load-schedule-policies` use-case.
 *
 * Read-only listing of all tier-bucket schedule policies for a tenant.
 * Powers two surfaces:
 *
 *   1. Admin schedule editor `/admin/renewals/settings/schedules`
 *      (T086) — renders 5 tabs (one per tier_bucket) with the current
 *      step list per bucket. Manager has read-only access; admin can
 *      mutate via `update-schedule-policy` (T082).
 *
 *   2. Pre-flight observability — the dispatcher cron (T088) emits a
 *      one-shot `renewal_tenant_misconfigured` warning when a tenant
 *      has zero policies (rare — SweCham seed populates 5 rows; tenant
 *      onboarding mirrors that fixture). Listing is the cheap probe.
 *
 * The use-case is intentionally NO-AUDIT: read-only listing of admin-
 * configurable tenant settings is not a privacy-relevant event; admins
 * who hit the editor don't generate noise in `audit_log`. Mutations
 * (`update-schedule-policy`) DO emit `renewal_schedule_policy_updated`.
 *
 * Tenant isolation: Postgres RLS enforces visibility — listing a
 * different tenant's policies returns zero rows automatically. There
 * is no cross-tenant probe semantic for "list all" (no specific id
 * being looked up), so the cross-tenant audit emit pattern from
 * `load-cycle-detail` does NOT apply here.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { TenantRenewalSchedulePolicy } from '../../domain/tenant-renewal-schedule-policy';

export const loadSchedulePoliciesInputSchema = z.object({
  tenantId: z.string().min(1),
});

export type LoadSchedulePoliciesInput = z.infer<
  typeof loadSchedulePoliciesInputSchema
>;

export interface LoadSchedulePoliciesOutput {
  readonly policies: ReadonlyArray<TenantRenewalSchedulePolicy>;
}

export type LoadSchedulePoliciesError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

export async function loadSchedulePolicies(
  deps: RenewalsDeps,
  rawInput: LoadSchedulePoliciesInput,
): Promise<
  Result<LoadSchedulePoliciesOutput, LoadSchedulePoliciesError>
> {
  return withActiveSpan(
    renewalsTracer(),
    'load_schedule_policies',
    { 'tenant.id': rawInput.tenantId },
    async (span) => {
      const parsed = loadSchedulePoliciesInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return err({
          kind: 'invalid_input',
          message: parsed.error.issues[0]?.message ?? 'invalid input',
        });
      }
      const policies = await deps.schedulePolicyRepo.listAllForTenant(
        parsed.data.tenantId,
      );
      span.setAttribute('renewals.policy_count', policies.length);
      return ok({ policies });
    },
  );
}
