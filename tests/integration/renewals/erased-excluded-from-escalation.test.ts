/**
 * COMP-1 (Member Erasure) — H4 completion regression net for the F8
 * renewal ESCALATION-TASK admin queue read.
 *
 * Erasure keeps `members.status` + the member's escalation tasks, and stamps
 * ONLY `erased_at` (scrubbing `company_name` to '[erased]'). The admin task
 * queue `listForAdminQueue` LEFT JOINs members and surfaces companyName for
 * the operational `/admin/renewals/tasks` surface — so it must add
 * `erased_at IS NULL` to keep a GDPR-erased member out of the queue.
 *
 * Seeds a kept (non-erased) control + an erased member, each with an OPEN
 * escalation task. RED before the filter (erased member appears) → GREEN
 * after.
 *
 * Live Neon.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import { makeDrizzleRenewalEscalationTaskRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-escalation-task-repo';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('F8 escalation-task admin queue excludes erased members (COMP-1 H4)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let keptId: string;
  let erasedId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-erased-esc-${randomUUID().slice(0, 8)}`;
    keptId = randomUUID();
    erasedId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Erased Escalation Plan' },
        renewalTierBucket: 'regular',
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    // Seed member + contact + cycle (the escalation-task FKs need them) +
    // an OPEN escalation task. Erasure stamps `erased_at` on the member.
    const seed = (memberId: string, erasedAt: Date | null) =>
      runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: erasedAt ? '[erased]' : 'Kept Escalation Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active', // erasure keeps status active
          erasedAt,
        });
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'Esc',
          lastName: 'Person',
          email: `esc-${randomUUID().slice(0, 6)}@example.com`,
          isPrimary: true,
          preferredLanguage: 'en',
        });
        const cycleId = randomUUID();
        await tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId,
          memberId,
          status: 'upcoming',
          periodFrom: new Date(Date.now() - 30 * MS_PER_DAY),
          periodTo: new Date(Date.now() + 30 * MS_PER_DAY),
          expiresAt: new Date(Date.now() + 30 * MS_PER_DAY),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: planId,
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
        });
        await tx.insert(renewalEscalationTasks).values({
          tenantId: tenant.ctx.slug,
          taskId: randomUUID(),
          memberId,
          cycleId,
          taskType: 'manual_outreach_required',
          assignedToRole: 'admin',
          assignedToUserId: null,
          dueAt: new Date(Date.now() + 7 * MS_PER_DAY),
          status: 'open',
        });
      });

    await seed(keptId, null);
    await seed(erasedId, new Date());
  }, 120_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db
      .delete(renewalEscalationTasks)
      .where(eq(renewalEscalationTasks.tenantId, slug))
      .catch(() => {});
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, slug)).catch(() => {});
    await db.delete(contacts).where(eq(contacts.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('listForAdminQueue excludes the erased member', async () => {
    const repo = makeDrizzleRenewalEscalationTaskRepo(tenant.ctx);
    const page = await repo.listForAdminQueue(tenant.ctx.slug, {
      pageSize: 100,
      sort: 'due_at_asc',
    });
    const memberIds = page.items.map((t) => t.memberId);
    expect(memberIds).toContain(keptId);
    expect(memberIds).not.toContain(erasedId);
  });
});
