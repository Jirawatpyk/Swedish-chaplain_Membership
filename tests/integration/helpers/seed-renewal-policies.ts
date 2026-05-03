/**
 * F8 Phase 2 Wave C verify-run remediation (B1) — per-test-tenant
 * `tenant_renewal_settings` + `tenant_renewal_schedule_policies` seed.
 *
 * Wave C-4 / migration 0089 seeds the SweCham defaults for tenant_id =
 * 'swecham' literal. Test tenants minted via `createTestTenant()` get
 * UUID-suffixed slugs like `test-swecham-abc12345` which DO NOT have
 * settings + schedule policies. Wave D-G integration tests that
 * exercise the dispatcher cron, the at-risk widget, or any code path
 * that reads from these two tables will fail with "row not found"
 * unless callers seed the defaults explicitly.
 *
 * Helper signature is intentionally minimal — `seedRenewalPolicies(slug)`
 * inserts the same 5-bucket fixture rows the SweCham seed produces in
 * 0089, parameterised by tenant slug. Idempotent via ON CONFLICT
 * DO NOTHING so re-calling within a single test setup is safe.
 *
 * Cleanup: `tests/integration/helpers/test-tenant.ts` cleanup hook
 * already deletes settings + schedule_policies rows scoped by
 * `tenant_id = slug` when the test tenant is torn down (added at
 * Wave C-4 but keyed by FK-cascade-from-membership_plans for the
 * shared tenant policies). Tests calling this helper inherit cleanup
 * for free.
 */
import { runInTenant } from '@/lib/db';
import {
  tenantRenewalSettings,
  tenantRenewalSchedulePolicies,
} from '@/modules/renewals/infrastructure/schema-tenant-renewal-config';
import type { TenantContext } from '@/modules/tenants';

const POLICIES = [
  {
    tier: 'thai_alumni' as const,
    steps: [
      { step_id: 't-30.email', offset_days: -30, channel: 'email' as const, template_id: 'renewal.t-30.thai_alumni' },
      { step_id: 't-14.email', offset_days: -14, channel: 'email' as const, template_id: 'renewal.t-14.thai_alumni' },
      { step_id: 't-3.email',  offset_days: -3,  channel: 'email' as const, template_id: 'renewal.t-3.thai_alumni' },
      { step_id: 't+7.email',  offset_days:  7,  channel: 'email' as const, template_id: 'renewal.t+7.thai_alumni' },
    ],
  },
  {
    tier: 'start_up' as const,
    steps: [
      { step_id: 't-60.email', offset_days: -60, channel: 'email' as const, template_id: 'renewal.t-60.start_up' },
      { step_id: 't-30.email', offset_days: -30, channel: 'email' as const, template_id: 'renewal.t-30.start_up' },
      { step_id: 't-14.email', offset_days: -14, channel: 'email' as const, template_id: 'renewal.t-14.start_up' },
      { step_id: 't-7.email',  offset_days: -7,  channel: 'email' as const, template_id: 'renewal.t-7.start_up' },
      { step_id: 't+0.email',  offset_days:  0,  channel: 'email' as const, template_id: 'renewal.t+0.start_up' },
      { step_id: 't+7.task.admin_notify', offset_days: 7, channel: 'task' as const, task_type: 'admin_notify_lapsed', assignee_role: 'admin' as const },
    ],
  },
  {
    tier: 'regular' as const,
    steps: [
      { step_id: 't-60.email', offset_days: -60, channel: 'email' as const, template_id: 'renewal.t-60.regular' },
      { step_id: 't-30.email', offset_days: -30, channel: 'email' as const, template_id: 'renewal.t-30.regular' },
      { step_id: 't-14.email', offset_days: -14, channel: 'email' as const, template_id: 'renewal.t-14.regular' },
      { step_id: 't-7.email',  offset_days: -7,  channel: 'email' as const, template_id: 'renewal.t-7.regular' },
      { step_id: 't+0.email',  offset_days:  0,  channel: 'email' as const, template_id: 'renewal.t+0.regular' },
      { step_id: 't+7.task.admin_notify', offset_days: 7, channel: 'task' as const, task_type: 'admin_notify_lapsed', assignee_role: 'admin' as const },
    ],
  },
  {
    tier: 'premium' as const,
    steps: [
      { step_id: 't-90.email', offset_days: -90, channel: 'email' as const, template_id: 'renewal.t-90.premium' },
      { step_id: 't-60.email', offset_days: -60, channel: 'email' as const, template_id: 'renewal.t-60.premium' },
      { step_id: 't-60.task.phone_call', offset_days: -60, channel: 'task' as const, task_type: 'phone_call', assignee_role: 'admin' as const },
      { step_id: 't-30.email', offset_days: -30, channel: 'email' as const, template_id: 'renewal.t-30.premium' },
      { step_id: 't-14.email', offset_days: -14, channel: 'email' as const, template_id: 'renewal.t-14.premium' },
      { step_id: 't-7.email',  offset_days: -7,  channel: 'email' as const, template_id: 'renewal.t-7.premium' },
      { step_id: 't-7.task.phone_call', offset_days: -7, channel: 'task' as const, task_type: 'phone_call', assignee_role: 'admin' as const },
      { step_id: 't+0.email',  offset_days:  0,  channel: 'email' as const, template_id: 'renewal.t+0.premium' },
      { step_id: 't+14.task.director_call', offset_days: 14, channel: 'task' as const, task_type: 'director_call', assignee_role: 'executive_director' as const },
    ],
  },
  {
    tier: 'partnership' as const,
    steps: [
      { step_id: 't-120.task.quarterly_review', offset_days: -120, channel: 'task' as const, task_type: 'quarterly_review_meeting', assignee_role: 'executive_director' as const },
      { step_id: 't-90.email', offset_days: -90, channel: 'email' as const, template_id: 'renewal.t-90.partnership' },
      { step_id: 't-90.task.meeting_proposed', offset_days: -90, channel: 'task' as const, task_type: 'meeting_proposed', assignee_role: 'executive_director' as const },
      { step_id: 't-60.task.benefit_fulfillment_report', offset_days: -60, channel: 'task' as const, task_type: 'benefit_fulfillment_report', assignee_role: 'executive_director' as const },
      { step_id: 't-30.email', offset_days: -30, channel: 'email' as const, template_id: 'renewal.t-30.partnership' },
      { step_id: 't-30.task.contract', offset_days: -30, channel: 'task' as const, task_type: 'contract_renewal', assignee_role: 'executive_director' as const },
      { step_id: 't-14.task.ed_phone_call', offset_days: -14, channel: 'task' as const, task_type: 'phone_call', assignee_role: 'executive_director' as const },
      { step_id: 't+0.task.in_person_meeting', offset_days: 0, channel: 'task' as const, task_type: 'in_person_meeting', assignee_role: 'executive_director' as const },
      { step_id: 't+30.task.board_escalation', offset_days: 30, channel: 'task' as const, task_type: 'board_escalation', assignee_role: 'executive_director' as const },
    ],
  },
] as const;

/**
 * Seed the 5 default schedule policies + an empty
 * `tenant_renewal_settings` row for the given test tenant. Mirrors
 * the SweCham migration 0089 fixture verbatim. Idempotent.
 */
export async function seedRenewalPolicies(
  tenantCtx: TenantContext,
): Promise<void> {
  await runInTenant(tenantCtx, async (tx) => {
    await tx
      .insert(tenantRenewalSettings)
      .values({ tenantId: tenantCtx.slug })
      .onConflictDoNothing();
    for (const policy of POLICIES) {
      await tx
        .insert(tenantRenewalSchedulePolicies)
        .values({
          tenantId: tenantCtx.slug,
          tierBucket: policy.tier,
          stepsJsonb: policy.steps,
        })
        .onConflictDoNothing();
    }
  });
}
