/**
 * 063 #5 · same-offsetDay (email + task) pair on the last window day —
 * neither step is permanently dropped (live Neon).
 *
 * Bug (xhigh review): some tiers seed TWO steps at the SAME offset_day
 * (premium `t-60.email` + `t-60.task.phone_call`; partnership
 * `t-90.email` + `t-90.task.meeting_proposed`). `findDueStepsForDate`
 * returns both at the same `target`; the dispatcher fired only ONE per
 * pass (the most-recent unfired). The second would fire on the NEXT pass
 * — UNLESS today is the EXACT last window day (`target = todayUtc -
 * lookback`), where the next day it slides out of the catch-up window →
 * the second (task) step is PERMANENTLY DROPPED (an admin escalation
 * task never created).
 *
 * Fix: co-resolve same-`target` steps — fire ALL unfired steps that
 * share the selected step's due-day this pass, so neither is dropped.
 *
 * Test scope:
 *   Seed a premium-tier cycle whose `t-60.email` + `t-60.task.phone_call`
 *   pair is due on the EXACT last window day (overdue by the full
 *   lookback). Run the dispatcher once.
 *     → BOTH steps fire this pass:
 *         - the email reminder_event (sent) + gateway send + audit
 *         - the task reminder_event (sent) + escalation_task row + audit
 *     → neither is dropped.
 *
 * RED proof against the one-step-per-pass code: only the email fires;
 * the task reminder_event + escalation_task are never created. The
 * task-row assertions fail.
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// premium t-60 pair (email + task) at offset -60.
//   cron run-date = 2026-05-15
//   last window day → t-60 due-date = run-date - 7 (full lookback) = 2026-05-08
//   expires_at = due-date + 60 = 2026-07-07
const NOW_ISO = '2026-05-15T08:00:00.000Z';
const EXPIRES_AT = new Date('2026-07-07T00:00:00.000Z');
// 1-year cycle anchored so year_in_cycle resolves to 1 for the step.
const PERIOD_FROM = new Date('2025-07-07T00:00:00.000Z');
const EXPECTED_DUE_DATE_ISO = new Date(
  Math.floor(EXPIRES_AT.getTime() / MS_PER_DAY) * MS_PER_DAY - 60 * MS_PER_DAY,
).toISOString();

describe('063 #5 same-offsetDay pair on last window day — live Neon', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let memberId: string;
  let cycleId: string;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenantA.ctx);

    planId = `f8-pair-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();

    await runInTenant(tenantA.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Premium Pair Plan' },
        sortOrder: 80,
        annualFeeMinorUnits: 30_000_000,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Premium Pair Co',
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
        email: `pair-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: PERIOD_FROM,
        periodTo: EXPIRES_AT,
        expiresAt: EXPIRES_AT,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'premium',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '300000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
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

  it('fires BOTH the t-60 email AND the t-60 task on the last window day (neither dropped)', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const gatewaySpy = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValue({
        ok: true,
        value: {
          deliveryId: `mock-delivery-${randomUUID().slice(0, 8)}`,
          dispatchedAt: NOW_ISO,
        },
      } as never);

    const r = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The email step fired (gateway saw exactly 1 send).
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
    expect(r.value.summary.emailsSent).toBe(1);

    // Both reminder_event rows exist — one email (sent), one task (sent).
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
    const byStep = new Map(reminderRows.map((row) => [row.stepId, row]));
    // RED against one-step-per-pass: the task row is absent.
    expect(byStep.has('t-60.email')).toBe(true);
    expect(byStep.has('t-60.task.phone_call')).toBe(true);
    expect(byStep.get('t-60.email')?.status).toBe('sent');
    expect(byStep.get('t-60.task.phone_call')?.status).toBe('sent');
    expect(byStep.get('t-60.task.phone_call')?.channel).toBe('task');
    expect(byStep.get('t-60.task.phone_call')?.taskType).toBe('phone_call');

    // The escalation task row was created (the admin escalation that was
    // being permanently dropped on the last window day).
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
    const phoneTask = taskRows.find((t) => t.taskType === 'phone_call');
    expect(phoneTask).toBeDefined();
    expect(phoneTask?.assignedToRole).toBe('admin');

    // Both audits emitted (renewal_reminder_sent + escalation_task_created).
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantA.ctx.slug));
    const sentAudit = audits.find(
      (a) =>
        a.eventType === ('renewal_reminder_sent' as never) &&
        (a.payload as Record<string, unknown> | null)?.step_id === 't-60.email',
    );
    const taskAudit = audits.find(
      (a) =>
        a.eventType === ('escalation_task_created' as never) &&
        (a.payload as Record<string, unknown> | null)?.step_id ===
          't-60.task.phone_call',
    );
    expect(sentAudit).toBeDefined();
    expect(taskAudit).toBeDefined();
    // The email's catch-up due-date provenance is the original (overdue) day.
    expect(
      (sentAudit?.payload as Record<string, unknown> | null)?.step_due_date,
    ).toBe(EXPECTED_DUE_DATE_ISO);

    gatewaySpy.mockRestore();
  }, 120_000);
});
