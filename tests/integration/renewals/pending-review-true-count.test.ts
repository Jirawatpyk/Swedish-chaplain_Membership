/**
 * #765 — the "Pending review" tab badge and the "showing the first N of M"
 * notice read the TRUE count (`cyclesRepo.countPendingReview`), not the length
 * of the first 200 rows.
 *
 * Seeded for tenant A, all `pending_admin_reactivation`:
 *   - 3 open cycles (kept members);
 *   - 1 cycle whose reject-with-refund already started → in `total`, not `open`;
 *   - 1 cycle for a GDPR-erased member → in neither (the list hides it too);
 *   - 1 `upcoming` cycle → in neither.
 * With `pageSize: 2` the list is capped below the count, so total > shown.
 *
 * Principle I: tenant B's count sees none of A's cycles.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { loadPendingReactivationReview, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function seedPlan(tenant: TestTenant, user: TestUser): Promise<string> {
  const planId = `f8-765-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, (tx) =>
    seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Pending Count Plan' },
      renewalTierBucket: 'regular',
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    }),
  );
  return planId;
}

async function seedCycle(
  tenant: TestTenant,
  planId: string,
  opts: { status?: 'pending_admin_reactivation' | 'upcoming'; erased?: boolean; refundStarted?: boolean } = {},
): Promise<void> {
  const memberId = randomUUID();
  const status = opts.status ?? 'pending_admin_reactivation';
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: opts.erased ? '[erased]' : 'Pending Count Co',
      country: 'TH',
      planId,
      planYear: 2026,
      status: 'active',
      erasedAt: opts.erased ? new Date() : null,
    });
    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId: randomUUID(),
      memberId,
      status,
      ...(status === 'pending_admin_reactivation'
        ? { enteredPendingAt: new Date(Date.now() - 2 * MS_PER_DAY) }
        : {}),
      ...(opts.refundStarted
        ? { rejectRefundInitiatedAt: new Date(), rejectRefundId: `rfnd_${randomUUID()}` }
        : {}),
      periodFrom: new Date(Date.now() - 30 * MS_PER_DAY),
      periodTo: new Date(Date.now() + 20 * MS_PER_DAY),
      expiresAt: new Date(Date.now() + 20 * MS_PER_DAY),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });
  });
}

async function cleanupTenant(tenant: TestTenant): Promise<void> {
  const slug = tenant.ctx.slug;
  await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, slug)).catch(() => {});
  await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
  await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, slug)).catch(() => {});
  await db.delete(auditLog).where(eq(auditLog.tenantId, slug)).catch(() => {});
  await tenant.cleanup().catch(() => {});
}

describe('#765 — pending review true count (live Neon)', () => {
  let a: TestTenant;
  let b: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    a = await createTestTenant();
    b = await createTestTenant();
    const planA = await seedPlan(a, user);
    const planB = await seedPlan(b, user);
    for (let i = 0; i < 3; i++) await seedCycle(a, planA);
    await seedCycle(a, planA, { refundStarted: true });
    await seedCycle(a, planA, { erased: true });
    await seedCycle(a, planA, { status: 'upcoming' });
    await seedCycle(b, planB);
  }, 180_000);

  afterAll(async () => {
    await cleanupTenant(a);
    await cleanupTenant(b);
  }, 120_000);

  it('counts every pending cycle (erased excluded), and the open ones apart, beyond the list cap', async () => {
    const res = await loadPendingReactivationReview(makeRenewalsDeps(a.ctx.slug), {
      tenantId: a.ctx.slug,
      pageSize: 2,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycles).toHaveLength(2);
    expect(res.value.totalCount).toBe(4);
    expect(res.value.openCount).toBe(3);
  });

  it('cross-tenant: tenant B counts only its own cycle', async () => {
    const counts = await makeRenewalsDeps(b.ctx.slug).cyclesRepo.countPendingReview(b.ctx.slug);
    expect(counts).toEqual({ total: 1, open: 1 });
  });
});
