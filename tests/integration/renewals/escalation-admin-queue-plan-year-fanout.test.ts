/**
 * F8 escalation-task admin queue — `membership_plans` JOIN fan-out
 * regression net (missing `plan_year` predicate).
 *
 * `membership_plans` is keyed `(tenant_id, plan_id, plan_year)` and is
 * CLONED per fiscal year, so a member's `plan_id` matches EVERY year's
 * clone. `listForAdminQueue` LEFT-JOINed `membership_plans` on
 * `(tenant_id, plan_id)` only — omitting `plan_year` — so one escalation
 * task FANNED OUT to N rows (N = number of plan_year clones), each row
 * potentially showing a DIFFERENT `renewal_tier_bucket`. Real symptom:
 * SCANIA appeared 4× in the queue (Regular×1 + Premium×3 = 4 clones).
 * `countMatching` joins only `members` (no plans) so it counts correctly
 * → the fan-out makes the LIST rows EXCEED the badge count (a count-vs-rows
 * divergence, the inverse of the R10 W4 "count > rows" class).
 *
 * Seeds ONE member on `(plan_id=P, plan_year=2026)` with TWO plan_year
 * clones of P (2025 = 'regular', 2026 = 'premium') and one OPEN escalation
 * task. Without the fix the member appears as 2 rows (fan-out); with the
 * `eq(membership_plans.plan_year, members.plan_year)` predicate it appears
 * as exactly 1 row carrying the member's CURRENT-year (2026) tier.
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

// Member's CURRENT plan_year (the one bound on the member row) and the
// tier its clone carries; the OTHER clone (prior year) carries a
// DIFFERENT tier so a fan-out would visibly flip the surfaced bucket.
const MEMBER_PLAN_YEAR = 2026;
const MEMBER_YEAR_TIER = 'premium';
const OTHER_PLAN_YEAR = 2025;
const OTHER_YEAR_TIER = 'regular';

describe('F8 escalation-task admin queue — membership_plans plan_year fan-out', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-fanout-esc-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();

    // Two plan_year clones of the SAME plan_id, with DIFFERENT tier buckets
    // — this is what makes a plan_year-blind JOIN fan out AND flip the tier.
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planYear: OTHER_PLAN_YEAR,
        planName: { en: 'Fan-out Plan (prior year)' },
        renewalTierBucket: OTHER_YEAR_TIER,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planYear: MEMBER_PLAN_YEAR,
        planName: { en: 'Fan-out Plan (current year)' },
        renewalTierBucket: MEMBER_YEAR_TIER,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
    });

    // One member bound to the CURRENT plan_year + contact + cycle (the
    // escalation-task FKs need them) + one OPEN escalation task.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Fan-out Escalation Co',
        country: 'TH',
        planId,
        planYear: MEMBER_PLAN_YEAR,
        status: 'active',
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
        tierAtCycleStart: MEMBER_YEAR_TIER,
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

  it('surfaces one member as exactly ONE row (no plan_year fan-out)', async () => {
    const repo = makeDrizzleRenewalEscalationTaskRepo(tenant.ctx);
    const page = await repo.listForAdminQueue(tenant.ctx.slug, {
      pageSize: 100,
      sort: 'due_at_asc',
    });

    // Two plan_year clones of P exist; a plan_year-blind JOIN would return
    // the member TWICE (once per clone). The composite-FK-correct join pins
    // to the member's own plan_year → exactly one row.
    const rowsForMember = page.items.filter((t) => t.memberId === memberId);
    expect(rowsForMember).toHaveLength(1);
  });

  it('surfaces the member CURRENT-year tier bucket, not another year clone', async () => {
    const repo = makeDrizzleRenewalEscalationTaskRepo(tenant.ctx);
    const page = await repo.listForAdminQueue(tenant.ctx.slug, {
      pageSize: 100,
      sort: 'due_at_asc',
    });
    const rowsForMember = page.items.filter((t) => t.memberId === memberId);
    const tiers = rowsForMember.map((t) => t.memberTierBucket);
    // The member is on plan_year 2026 → its tier ('premium'), never the
    // 2025 clone's tier ('regular').
    expect(tiers).toEqual([MEMBER_YEAR_TIER]);
    expect(tiers).not.toContain(OTHER_YEAR_TIER);
  });

  it('countMatching agrees with the list row count (no fan-out divergence)', async () => {
    const repo = makeDrizzleRenewalEscalationTaskRepo(tenant.ctx);
    // countMatching joins only `members` (no plans) so it counts 1; the list
    // must match. Before the fix the list fanned out to 2 → rows > count.
    const count = await repo.countMatching(tenant.ctx.slug, {});
    const page = await repo.listForAdminQueue(tenant.ctx.slug, {
      pageSize: 100,
      sort: 'due_at_asc',
    });
    expect(page.items.length).toBe(count);
  });
});
