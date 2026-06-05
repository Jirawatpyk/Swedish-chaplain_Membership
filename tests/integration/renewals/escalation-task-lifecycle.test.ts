/**
 * F8 Phase 8 T223 — escalation task lifecycle (live Neon).
 *
 * Verifies T209/T210/T211 transitions + audit emit-in-tx invariant
 * (Constitution Principle VIII) against a live Neon ap-southeast-1
 * tenant. Test scope:
 *
 *   1. Complete: open → done with outcome note → row mutated +
 *      `escalation_task_completed` audit emitted.
 *   2. Skip: open → skipped with required reason → row mutated +
 *      `escalation_task_skipped` audit emitted with skipped_reason
 *      payload.
 *   3. Reassign: assigned_to_user_id=NULL → user-A → audit emitted
 *      with from_user_id=null + to_user_id payload.
 *   4. Negative: complete on already-done task returns `task_not_open`
 *      + no extra audit emit.
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
  completeEscalationTask,
  skipEscalationTask,
  reassignEscalationTask,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { asTaskId } from '@/modules/renewals/domain/renewal-escalation-task';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FUTURE_DUE_AT = new Date(Date.now() + 7 * MS_PER_DAY);
const PERIOD_FROM = new Date(Date.now() - 30 * MS_PER_DAY);
const PERIOD_TO = new Date(Date.now() + 60 * MS_PER_DAY);

interface SeededMemberCycle {
  readonly memberId: string;
  readonly cycleId: string;
}

/**
 * Seed members + contacts + renewal_cycles rows so the
 * `renewal_escalation_tasks` FK constraints (member_fk + cycle_fk) hold
 * before inserting the task itself. Mirrors the F8 at-risk-snooze
 * integration test pattern (T175).
 */
async function seedMemberWithCycle(
  tenant: TestTenant,
  user: TestUser,
): Promise<SeededMemberCycle> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const planId = `f8-task-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Task Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    });
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Task Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Task',
      lastName: 'Person',
      email: `task-${randomUUID().slice(0, 6)}@acme.example`,
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

async function seedOpenTask(
  tenant: TestTenant,
  args: {
    readonly memberId: string;
    readonly cycleId: string | null;
    readonly taskType: string;
    readonly assignedToUserId?: string | null;
  },
): Promise<string> {
  const taskId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(renewalEscalationTasks).values({
      tenantId: tenant.ctx.slug,
      taskId,
      memberId: args.memberId,
      cycleId: args.cycleId,
      taskType: args.taskType,
      assignedToRole: 'admin',
      assignedToUserId: args.assignedToUserId ?? null,
      dueAt: FUTURE_DUE_AT,
      status: 'open',
    });
  });
  return taskId;
}

describe('F8 escalation task lifecycle — integration (T223)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let admin2: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    admin2 = await createActiveTestUser('admin');
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
    // matches the rows we want to drop. Without this wrap, prior test
    // audits leak into the current test (4th-test count assertion fail).
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(renewalEscalationTasks);
      await tx.delete(renewalCycles);
      await tx.delete(auditLog);
    }).catch(() => {});
  });

  it('complete: open → done with outcome note + audit', async () => {
    const { memberId, cycleId } = await seedMemberWithCycle(tenant, admin);
    const taskId = await seedOpenTask(tenant, {
      memberId,
      cycleId,
      taskType: 'phone_call',
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const r = await completeEscalationTask(deps, {
      tenantId: tenant.ctx.slug,
      taskId,
      outcomeNote: 'Spoke with member; renewing next week',
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);

    const row = await db
      .select()
      .from(renewalEscalationTasks)
      .where(
        and(
          eq(renewalEscalationTasks.tenantId, tenant.ctx.slug),
          eq(renewalEscalationTasks.taskId, asTaskId(taskId)),
        ),
      )
      .limit(1);
    expect(row[0]?.status).toBe('done');
    expect(row[0]?.outcomeNote).toBe('Spoke with member; renewing next week');
    expect(row[0]?.closedByUserId).toBe(admin.userId);
    expect(row[0]?.closedAt).not.toBeNull();

    // Round 5 C-7 close — narrow by `payload ->> 'task_id' = ${taskId}`
    // so a leaked audit row from an adjacent test (RLS-shielded
    // beforeEach DELETE may not always clear if a prior tx commit
    // barrier interleaves) doesn't flip the count and red the test.
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'escalation_task_completed' as never),
          sql`payload ->> 'task_id' = ${taskId}`,
        ),
      );
    expect(audits.length).toBe(1);
    // R10 W6 close — pin the 5-year retention default (PDPA §24
    // proportionality + member-data norm). F4 trigger covers tax-
    // doc events only; F8 escalation events rely on column DEFAULT 5
    // with no DB-layer enforcement trigger. Test-level pin defends
    // against a future migration changing the column default. Raw SQL
    // because `retention_years` exists in the DB (migration 0039) but
    // is not yet wired into the Drizzle inferred type.
    const retentionRows = (await db.execute(
      sql`select retention_years from audit_log where id = ${audits[0]?.id}`,
    )) as unknown as ReadonlyArray<{ retention_years: number }>;
    expect(retentionRows[0]?.retention_years).toBe(5);
  }, 60_000);

  it('skip: open → skipped with required reason + audit', async () => {
    const { memberId, cycleId } = await seedMemberWithCycle(tenant, admin);
    const taskId = await seedOpenTask(tenant, {
      memberId,
      cycleId,
      taskType: 'in_person_meeting',
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const r = await skipEscalationTask(deps, {
      tenantId: tenant.ctx.slug,
      taskId,
      skippedReason: 'Member unreachable; will revisit at T-30',
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);

    const row = await db
      .select()
      .from(renewalEscalationTasks)
      .where(eq(renewalEscalationTasks.taskId, asTaskId(taskId)))
      .limit(1);
    expect(row[0]?.status).toBe('skipped');
    expect(row[0]?.skippedReason).toBe(
      'Member unreachable; will revisit at T-30',
    );
    expect(row[0]?.outcomeNote).toBeNull();

    // Round 5 C-7 close — narrow by task_id (see complete test above).
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'escalation_task_skipped' as never),
          sql`payload ->> 'task_id' = ${taskId}`,
        ),
      );
    expect(audits.length).toBe(1);
    // R10 W6 close — 5-year retention default for skip event (raw SQL
    // because retention_years not yet in Drizzle inferred type).
    const retentionRows = (await db.execute(
      sql`select retention_years from audit_log where id = ${audits[0]?.id}`,
    )) as unknown as ReadonlyArray<{ retention_years: number }>;
    expect(retentionRows[0]?.retention_years).toBe(5);
    expect(
      (audits[0]?.payload as { skipped_reason?: string })?.skipped_reason,
    ).toBe('Member unreachable; will revisit at T-30');
  }, 60_000);

  it('reassign: NULL assignee → admin2 + audit captures from/to', async () => {
    const { memberId, cycleId } = await seedMemberWithCycle(tenant, admin);
    const taskId = await seedOpenTask(tenant, {
      memberId,
      cycleId,
      taskType: 'board_escalation',
      assignedToUserId: null,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const r = await reassignEscalationTask(deps, {
      tenantId: tenant.ctx.slug,
      taskId,
      toUserId: admin2.userId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);

    const row = await db
      .select()
      .from(renewalEscalationTasks)
      .where(eq(renewalEscalationTasks.taskId, asTaskId(taskId)))
      .limit(1);
    expect(row[0]?.assignedToUserId).toBe(admin2.userId);

    // Round 5 C-7 close — narrow by task_id (see complete test above).
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'escalation_task_reassigned' as never),
          sql`payload ->> 'task_id' = ${taskId}`,
        ),
      );
    expect(audits.length).toBe(1);
    const payload = audits[0]?.payload as {
      from_user_id?: string | null;
      to_user_id?: string;
      actor_user_id?: string;
    };
    expect(payload?.from_user_id).toBeNull();
    expect(payload?.to_user_id).toBe(admin2.userId);
    expect(payload?.actor_user_id).toBe(admin.userId);
    // R10 W6 close — 5-year retention default for reassign event (raw
    // SQL because retention_years not yet in Drizzle inferred type).
    const retentionRows = (await db.execute(
      sql`select retention_years from audit_log where id = ${audits[0]?.id}`,
    )) as unknown as ReadonlyArray<{ retention_years: number }>;
    expect(retentionRows[0]?.retention_years).toBe(5);
  }, 60_000);

  it('complete on already-done task → task_not_open + no duplicate audit', async () => {
    const { memberId, cycleId } = await seedMemberWithCycle(tenant, admin);
    const taskId = await seedOpenTask(tenant, {
      memberId,
      cycleId,
      taskType: 'phone_call',
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // First complete — succeeds.
    const r1 = await completeEscalationTask(deps, {
      tenantId: tenant.ctx.slug,
      taskId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r1.ok).toBe(true);

    // Second complete — task_not_open.
    const r2 = await completeEscalationTask(deps, {
      tenantId: tenant.ctx.slug,
      taskId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe('task_not_open');

    // Filter by task_id to isolate this test's audits from any
    // pre-existing audit rows on the shared test tenant (RLS-shielded
    // beforeEach DELETE may not always clear if a prior run committed
    // before tx commit barrier — defensive narrowing makes the
    // assertion robust against test-order pollution).
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'escalation_task_completed' as never),
          sql`payload ->> 'task_id' = ${taskId}`,
        ),
      );
    expect(audits.length).toBe(1);
  }, 60_000);
});
