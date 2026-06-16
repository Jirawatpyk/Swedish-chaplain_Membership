/**
 * COMP-1 (Member Erasure) — H4 regression net for F8 PROCESSING enumerations.
 *
 * Erasure keeps `status` (often 'active') and the member's renewal cycle, and
 * stamps only `erased_at`. So the cron candidate-selection reads that enumerate
 * members for processing — the reminder DISPATCHER and the weekly TIER-UPGRADE
 * evaluator — would still pick up an anonymised '[erased]' tombstone unless
 * they add `erased_at IS NULL`. This proves both candidate lists exclude it:
 *   - `DispatchCandidateRepo.list` (renewal-reminder email candidates)
 *   - `TierUpgradeEvalCandidateRepo.list` (auto-upgrade evaluation candidates)
 *
 * Seeds an erased member + an active cycle directly + a non-erased control.
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
import { makeDrizzleDispatchCandidateRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo';
import { makeDrizzleTierUpgradeEvalCandidateRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-eval-candidate-repo';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('F8 processing candidate reads exclude erased members (COMP-1 H4)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let keptId: string;
  let erasedId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-erased-proc-${randomUUID().slice(0, 8)}`;
    keptId = randomUUID();
    erasedId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Erased Proc Plan' },
        // renewal_tier_bucket is required by the tier-upgrade candidate join.
        renewalTierBucket: 'regular',
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    const seed = (memberId: string, erasedAt: Date | null) =>
      runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: erasedAt ? '[erased]' : 'Kept Proc Co',
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
          firstName: 'Proc',
          lastName: 'Person',
          email: `proc-${randomUUID().slice(0, 6)}@example.com`,
          isPrimary: true,
          preferredLanguage: 'en',
        });
        // An active (upcoming) cycle expiring within the dispatch window.
        await tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId: randomUUID(),
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
      });

    await seed(keptId, null);
    await seed(erasedId, new Date());
  }, 120_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, slug)).catch(() => {});
    await db.delete(contacts).where(eq(contacts.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('DispatchCandidateRepo.list excludes the erased member', async () => {
    const repo = makeDrizzleDispatchCandidateRepo(tenant.ctx);
    const page = await repo.list(tenant.ctx.slug, {
      cutoffExpiresAt: new Date(Date.now() + 90 * MS_PER_DAY).toISOString(),
      maxOffsetDays: 30,
      pageSize: 100,
    });
    const ids = page.items.map((c) => c.cycle.memberId);
    expect(ids).toContain(keptId);
    expect(ids).not.toContain(erasedId);
  });

  it('TierUpgradeEvalCandidateRepo.list excludes the erased member', async () => {
    const repo = makeDrizzleTierUpgradeEvalCandidateRepo(tenant.ctx);
    const page = await repo.list(tenant.ctx.slug, { pageSize: 100 });
    const ids = page.items.map((c) => c.memberId);
    expect(ids).toContain(keptId);
    expect(ids).not.toContain(erasedId);
  });
});
