/**
 * F8 Phase 7 T204 — Tier-upgrade reconcile-pending-applications cron —
 * integration (live Neon).
 *
 * Verifies the weekly reconcile cron's orphan-detection branch
 * against a live Neon ap-southeast-1 tenant. Test scope:
 *
 *   1. Cancelled-cycle orphan — `accepted_pending_apply` suggestion
 *      whose target cycle is `cancelled` ⇒ reconcile dismisses with
 *      `reason='orphan_target_cycle_terminal'` + emits
 *      `tier_upgrade_pending_orphan_detected`.
 *   2. Lapsed-cycle orphan — same branch with `lapsed` cycle status.
 *   3. Healthy pending — non-terminal cycle ⇒ NOT touched.
 *   4. Idempotent — re-running the cron after orphan dismissal does
 *      NOT re-emit the audit (already-dismissed rows excluded).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import {
  reconcilePendingApplications,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// 055-member-number — raw member seeds (bypassing the createMember allocator)
// must supply a distinct positive `member_number` per the NOT NULL + per-tenant
// UNIQUE index. Monotonic counter keeps every seed in the shared test tenant
// collision-free.
let memberNumberSeq = 0;
function nextMemberNumber(): number {
  memberNumberSeq += 1;
  return memberNumberSeq;
}

interface SeededOrphan {
  readonly memberId: string;
  readonly cycleId: string;
  readonly suggestionId: string;
}

async function seedOrphan(
  tenant: TestTenant,
  cycleStatus: 'cancelled' | 'lapsed' | 'upcoming',
): Promise<SeededOrphan> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const suggestionId = randomUUID();
  const now = Date.now();
  const expiresAt = new Date(now + 60 * MS_PER_DAY);

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextMemberNumber(),
      companyName: 'Reconcile Co',
      country: 'TH',
      planId: 'regular',
      planYear: 2026,
    });
    const closedFields =
      cycleStatus === 'cancelled' || cycleStatus === 'lapsed'
        ? {
            closedAt: new Date(),
            closedReason: cycleStatus === 'lapsed' ? 'lapsed' : 'cancelled',
          }
        : {};
    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      status: cycleStatus,
      periodFrom: new Date(now - 30 * MS_PER_DAY),
      periodTo: expiresAt,
      expiresAt,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: 'regular',
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      ...closedFields,
    });
    await tx.insert(tierUpgradeSuggestions).values({
      tenantId: tenant.ctx.slug,
      suggestionId,
      memberId,
      fromPlanId: 'regular',
      toPlanId: 'premium',
      reasonCode: 'declared_turnover_above_threshold',
      evidenceJsonb: {
        reasonCode: 'declared_turnover_above_threshold',
        turnoverThb: 120_000_000,
        thresholdMetAt: new Date().toISOString(),
      },
      status: 'accepted_pending_apply',
      acceptedAt: new Date(now - 10 * MS_PER_DAY),
      acceptedByUserId: randomUUID(),
      targetApplyAtCycleId: cycleId,
    });
  });

  return { memberId, cycleId, suggestionId };
}

async function clearTenant(tenant: TestTenant): Promise<void> {
  for (const tableQuery of [
    db
      .delete(tierUpgradeSuggestions)
      .where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)),
    db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
    db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
    db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
  ]) {
    await tableQuery.catch(() => {});
  }
}

async function clearTenantFull(tenant: TestTenant): Promise<void> {
  await clearTenant(tenant);
  await db
    .delete(membershipPlans)
    .where(eq(membershipPlans.tenantId, tenant.ctx.slug))
    .catch(() => {});
}

describe('F8 tier-upgrade reconcile — integration (T204)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // FK from members.plan_id needs a regular-tier plan in the catalogue.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'regular',
        planYear: 2026,
        planName: { en: 'Regular' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 5_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: 50_000_000,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        renewalTierBucket: 'regular',
        isActive: true,
        createdBy: admin.userId,
        updatedBy: admin.userId,
      });
    });
  }, 180_000);

  afterAll(async () => {
    await clearTenantFull(tenant).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    await clearTenant(tenant);
  });

  it('cancelled-cycle orphan — dismisses + emits audit', async () => {
    const seeded = await seedOrphan(tenant, 'cancelled');
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await reconcilePendingApplications(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.orphansDetected).toBe(1);
    expect(result.value.orphansDismissed).toBe(1);

    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('dismissed');
    expect(suggestion?.dismissedReason).toBe('orphan_target_cycle_terminal');
    expect(suggestion?.closedAt).not.toBeNull();

    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_pending_orphan_detected')),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('lapsed-cycle orphan — dismisses + emits audit', async () => {
    const seeded = await seedOrphan(tenant, 'lapsed');
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await reconcilePendingApplications(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.orphansDetected).toBe(1);
    expect(result.value.orphansDismissed).toBe(1);

    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('dismissed');
    expect(suggestion?.dismissedReason).toBe('orphan_target_cycle_terminal');
  }, 60_000);

  it('healthy pending — non-terminal cycle is NOT touched', async () => {
    const seeded = await seedOrphan(tenant, 'upcoming');
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await reconcilePendingApplications(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.orphansDetected).toBe(0);
    expect(result.value.orphansDismissed).toBe(0);

    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('accepted_pending_apply');
  }, 60_000);

  it('idempotent — re-running does not re-emit audit', async () => {
    await seedOrphan(tenant, 'cancelled');
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const auditsBefore = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_pending_orphan_detected')),
    );

    const first = await reconcilePendingApplications(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.orphansDismissed).toBe(1);

    const auditsAfterFirst = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_pending_orphan_detected')),
    );
    expect(auditsAfterFirst.length - auditsBefore.length).toBe(1);

    const second = await reconcilePendingApplications(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.orphansDetected).toBe(0);
    expect(second.value.orphansDismissed).toBe(0);

    // Second pass adds zero new audits.
    const auditsAfterSecond = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_pending_orphan_detected')),
    );
    expect(auditsAfterSecond.length).toBe(auditsAfterFirst.length);
  }, 60_000);
});
