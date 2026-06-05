/**
 * F8 Phase 8 T224 — escalation task partial-unique idempotency
 * (live Neon).
 *
 * Verifies the partial unique index `renewal_escalation_tasks_open_idem_idx`
 * (tenant, member, cycle, task_type) WHERE status='open' (data-model.md
 * § 2.7 + migration 0092) holds:
 *
 *   1. createEscalationTask called twice with identical key → second
 *      call returns the existing row, `created=false`, only ONE
 *      `escalation_task_created` audit row.
 *   2. Close task A=done → re-insert with same key succeeds (uniqueness
 *      applies only to status='open').
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import {
  createEscalationTask,
  completeEscalationTask,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FUTURE_DUE_AT = new Date(Date.now() + 7 * MS_PER_DAY).toISOString();
const PERIOD_FROM = new Date(Date.now() - 30 * MS_PER_DAY);
const PERIOD_TO = new Date(Date.now() + 60 * MS_PER_DAY);

interface SeededMemberCycle {
  readonly memberId: string;
  readonly cycleId: string;
}

async function seedMemberWithCycle(
  tenant: TestTenant,
  user: TestUser,
): Promise<SeededMemberCycle> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const planId = `f8-task-idem-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Idem Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Idem Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Idem',
      lastName: 'Person',
      email: `idem-${randomUUID().slice(0, 6)}@acme.example`,
      isPrimary: true,
      preferredLanguage: 'en',
    });
    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      status: 'upcoming',
      periodFrom: PERIOD_FROM,
      periodTo: PERIOD_TO,
      expiresAt: PERIOD_TO,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });
  });
  return { memberId, cycleId };
}

describe('F8 escalation task idempotency — integration (T224)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalEscalationTasks)
      .where(eq(renewalEscalationTasks.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    // RLS+FORCE on audit_log + renewal_escalation_tasks blocks DELETEs
    // from outside a tenant context. Wrap deletions in runInTenant so
    // the policy `tenant_id = current_setting('app.current_tenant')`
    // matches the rows we want to drop.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(renewalEscalationTasks);
      await tx.delete(renewalCycles);
      await tx.delete(auditLog);
    }).catch(() => {});
  });

  it('createEscalationTask twice with same key → 1 row, 2 audits with idempotent_replay flag', async () => {
    const { memberId, cycleId } = await seedMemberWithCycle(tenant, admin);
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const baseInput = {
      tenantId: tenant.ctx.slug,
      memberId,
      cycleId,
      taskType: 'manual_outreach_required',
      assignedToRole: 'admin' as const,
      dueAt: FUTURE_DUE_AT,
      // R10 S9 close — closed-enum triggerReason.
      triggerReason: 'no_primary_contact' as const,
      actorUserId: admin.userId,
      actorRole: 'admin' as const,
      correlationId: randomUUID(),
    };

    const r1 = await createEscalationTask(deps, baseInput);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.created).toBe(true);

    const r2 = await createEscalationTask(deps, baseInput);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.created).toBe(false);
      // Same task_id returned from the partial-unique short-circuit.
      if (r1.ok) expect(r2.value.taskId).toBe(r1.value.taskId);
    }

    const rows = await db
      .select()
      .from(renewalEscalationTasks)
      .where(
        and(
          eq(renewalEscalationTasks.tenantId, tenant.ctx.slug),
          eq(renewalEscalationTasks.memberId, memberId),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('open');

    // Both calls emit audits — second has idempotent_replay=true.
    // Round 5 C-7 close — narrow by task_id so cross-tenant probes or
    // prior-test leakage in the shared tenant cannot flip the count.
    // R6 IMP-20 close — fail loudly if r1 setup didn't succeed
    // (previously the ternary fell back to '' and the audit-count
    // assertion produced a confusing "expected 2 got 0" diagnostic).
    if (!r1.ok) {
      throw new Error(`r1 setup failed: ${JSON.stringify(r1.error)}`);
    }
    const taskId = r1.value.taskId;
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'escalation_task_created' as never),
          sql`payload ->> 'task_id' = ${taskId}`,
        ),
      );
    expect(audits.length).toBe(2);
    const replayFlags = audits
      .map((a) => (a.payload as { idempotent_replay?: boolean }).idempotent_replay)
      .sort();
    expect(replayFlags).toEqual([false, true]);
  }, 60_000);

  it('partial unique only applies to open: close A=done → new row with same key succeeds', async () => {
    const { memberId, cycleId } = await seedMemberWithCycle(tenant, admin);
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const baseInput = {
      tenantId: tenant.ctx.slug,
      memberId,
      cycleId,
      taskType: 'phone_call',
      assignedToRole: 'admin' as const,
      dueAt: FUTURE_DUE_AT,
      triggerReason: 'scheduled_cron_step' as const,
      actorUserId: admin.userId,
      actorRole: 'admin' as const,
      correlationId: randomUUID(),
    };

    const r1 = await createEscalationTask(deps, baseInput);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Close A.
    const close = await completeEscalationTask(deps, {
      tenantId: tenant.ctx.slug,
      taskId: r1.value.taskId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(close.ok).toBe(true);

    // Insert a fresh open task with same key — should succeed (the
    // existing row is now status='done' so the partial unique allows a
    // new open row).
    const r2 = await createEscalationTask(deps, baseInput);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.created).toBe(true);
      expect(r2.value.taskId).not.toBe(r1.value.taskId);
    }

    const rows = await db
      .select({ status: renewalEscalationTasks.status })
      .from(renewalEscalationTasks)
      .where(
        and(
          eq(renewalEscalationTasks.tenantId, tenant.ctx.slug),
          eq(renewalEscalationTasks.memberId, memberId),
        ),
      );
    expect(rows.length).toBe(2);
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(['done', 'open']);
  }, 60_000);
});
