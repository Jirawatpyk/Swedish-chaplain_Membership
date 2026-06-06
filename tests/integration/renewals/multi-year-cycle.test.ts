/**
 * F8 Phase 4 Wave I8 · T110 — multi-year cycle reminder gating (live Neon).
 *
 * FR-010 + Q4 round 1 contract: partnership-tier members on 3-year
 * cycles MUST receive task-channel reminders annually (e.g. quarterly
 * reviews, benefit-fulfillment reports) but MUST NOT receive renewal
 * email reminders until the FINAL year of the cycle. The
 * `multi_year_non_final_year` skip gate (dispatch-one-cycle Gate 9)
 * enforces this.
 *
 * Test scope (two scenarios on year 1 of a 3-year Partnership cycle):
 *   1. T-30 step due — first-match in partnership schedule is
 *      `t-30.email` (channel=email). yearInCycle=1, cycleYears=3 →
 *      Gate 9 skips with reason `multi_year_non_final_year`.
 *   2. T-120 step due — first-match is `t-120.task.quarterly_review`
 *      (channel=task). Gate 9 does NOT apply (task channel) →
 *      `escalation_task_created` audit + reminder_event row sent.
 *
 * `period_from` is set independently of `expires_at` so the gate can
 * be exercised without faithfully modelling the production annual-
 * anchor convention. cycleLengthMonths = 36 forces cycleYears = 3.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import { dispatchRenewalCycle, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// Use a corporate-tier benefit matrix on the underlying membership_plans
// row — the partnership-bundles-corporate CHECK constraint requires
// partnership category plans to declare an `includes_corporate_plan_id`,
// which would force seeding two plans. The dispatcher's schedule lookup
// reads `renewal_cycles.tier_at_cycle_start` (set to 'partnership' below)
// so the integration scenario still exercises the partnership policy.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REAL_NOW_MS = Date.now();
const NOW_ISO = new Date(REAL_NOW_MS).toISOString();
// year 1 → period_from is 30 days ago.
const PERIOD_FROM = new Date(REAL_NOW_MS - 30 * MS_PER_DAY);

async function seedPartnership(
  tenantA: TestTenant,
  user: TestUser,
  expiresAt: Date,
): Promise<{ memberId: string; cycleId: string }> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const planId = `f8-multi-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenantA.ctx, async (tx) => {
    await seedF8MembershipPlan(tx, {
      tenantSlug: tenantA.ctx.slug,
      planId,
      planName: { en: 'Partnership Plan' },
      sortOrder: 90,
      annualFeeMinorUnits: 50_000_000,
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    });
    await tx.insert(members).values({
      tenantId: tenantA.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Partnership Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
    await tx.insert(contacts).values({
      tenantId: tenantA.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Anna',
      lastName: 'Adm',
      email: `partner-${randomUUID().slice(0, 6)}@acme.example`,
      isPrimary: true,
      preferredLanguage: 'en',
    });
    await tx.insert(renewalCycles).values({
      tenantId: tenantA.ctx.slug,
      cycleId,
      memberId,
      status: 'upcoming',
      periodFrom: PERIOD_FROM,
      periodTo: expiresAt,
      expiresAt,
      cycleLengthMonths: 36, // 3-year partnership cycle
      tierAtCycleStart: 'partnership',
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '500000.00',
      frozenPlanTermMonths: 36,
      frozenPlanCurrency: 'THB',
    });
  });
  return { memberId, cycleId };
}

describe('F8 multi-year cycle gating — integration (T110)', () => {
  let tenantA: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenantA.ctx);
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalEscalationTasks)
      .where(eq(renewalEscalationTasks.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalReminderEvents)
      .where(eq(renewalReminderEvents.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await tenantA.cleanup().catch(() => {});
  }, 120_000);

  it('Year 1 / T-30 email step due → Gate 9 skips multi_year_non_final_year', async () => {
    // expires_at = real-now + 30d → T-30 email step matches today.
    const expiresAt = new Date(REAL_NOW_MS + 30 * MS_PER_DAY);
    const { cycleId } = await seedPartnership(tenantA, user, expiresAt);

    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const gatewaySpy = vi.spyOn(deps.renewalGateway, 'sendRenewalEmail');

    const r = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary.emailsSent).toBe(0);
    expect(r.value.summary.skipped.multi_year_non_final_year).toBe(1);
    expect(gatewaySpy).not.toHaveBeenCalled();

    // No reminder_event row was created (Gate 9 returns before insert).
    const reminderRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalReminderEvents)
        .where(
          and(
            eq(renewalReminderEvents.tenantId, tenantA.ctx.slug),
            eq(renewalReminderEvents.cycleId, cycleId),
          ),
        ),
    );
    expect(reminderRows).toHaveLength(0);

    // Audit emitted with reason payload.
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantA.ctx.slug),
          eq(auditLog.eventType, 'renewal_reminder_skipped' as never),
        ),
      );
    const skipAudit = audits.find(
      (a) =>
        (a.payload as Record<string, unknown> | null)?.reason ===
        'multi_year_non_final_year',
    );
    expect(skipAudit).toBeDefined();
    expect(
      (skipAudit?.payload as Record<string, unknown> | null)?.year_in_cycle,
    ).toBe(1);
    expect(
      (skipAudit?.payload as Record<string, unknown> | null)?.cycle_years,
    ).toBe(3);

    gatewaySpy.mockRestore();
  }, 120_000);

  it('Year 1 / T-120 task step due → escalation_task_created (Gate 9 NOT applied to task channel)', async () => {
    // expires_at = real-now + 120d → T-120 task step matches today.
    const expiresAt = new Date(REAL_NOW_MS + 120 * MS_PER_DAY);
    const { cycleId } = await seedPartnership(tenantA, user, expiresAt);

    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const gatewaySpy = vi.spyOn(deps.renewalGateway, 'sendRenewalEmail');

    const r = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The previous test's cycle is also a candidate — but its T-30
    // email skipped via Gate 9 again. Only the new T-120 task fires.
    expect(r.value.summary.tasksCreated).toBe(1);
    expect(gatewaySpy).not.toHaveBeenCalled();

    // Reminder_event for the task channel was inserted + sent.
    const reminderRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalReminderEvents)
        .where(
          and(
            eq(renewalReminderEvents.tenantId, tenantA.ctx.slug),
            eq(renewalReminderEvents.cycleId, cycleId),
          ),
        ),
    );
    expect(reminderRows).toHaveLength(1);
    expect(reminderRows[0]?.channel).toBe('task');
    expect(reminderRows[0]?.taskType).toBe('quarterly_review_meeting');
    expect(reminderRows[0]?.status).toBe('sent');

    // Escalation task row created.
    const taskRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalEscalationTasks)
        .where(
          and(
            eq(renewalEscalationTasks.tenantId, tenantA.ctx.slug),
            eq(renewalEscalationTasks.cycleId, cycleId),
          ),
        ),
    );
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.taskType).toBe('quarterly_review_meeting');
    expect(taskRows[0]?.assignedToRole).toBe('executive_director');

    // escalation_task_created audit emitted.
    const taskAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantA.ctx.slug),
          eq(auditLog.eventType, 'escalation_task_created' as never),
        ),
      );
    expect(
      taskAudits.find(
        (a) =>
          (a.payload as Record<string, unknown> | null)?.task_type ===
          'quarterly_review_meeting',
      ),
    ).toBeDefined();

    gatewaySpy.mockRestore();
  }, 120_000);
});
