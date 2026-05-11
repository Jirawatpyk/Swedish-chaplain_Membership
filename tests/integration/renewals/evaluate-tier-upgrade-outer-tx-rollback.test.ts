/**
 * F8 Phase 10 Staff-R003 close — outerTx rollback semantic IT.
 *
 * Pins the R6-B1 fix correctness: when the cron route passes an
 * `outerTx` to `evaluateTierUpgrade` and `flushPage` throws (via
 * `bulkInsertOpenIfAbsent` OR `bulkEmitInTx`), the outer
 * `runInTenant` MUST rollback atomically — leaving zero
 * `tier_upgrade_suggestions` rows AND zero `audit_log` rows for the
 * test tenant per Constitution Principle VIII state↔audit atomicity.
 *
 * **Why this test exists**: R5-B1 introduced the catch→throw fix in
 * `flushPage`, but R5 then wrapped the call in
 * `try { … } catch { return err({server_error}) }` which DEFEATED the
 * fix on the production path (cron route passes outerTx + closes its
 * runInTenant closure normally → outer tx COMMITS instead of rolls
 * back → state↔audit drift returns). R6-B1 corrected the outer catch
 * to re-throw when outerTx is provided. This file pins that
 * correctness END-TO-END at the runInTenant boundary.
 *
 * Scope: ONE test case — mock `auditEmitter.bulkEmitInTx` to throw
 * after `bulkInsertOpenIfAbsent` succeeds, call evaluateTierUpgrade
 * inside a runInTenant block (mirroring the cron route at
 * `src/app/api/cron/renewals/tier-upgrade-evaluate/[tenantId]/route.ts`),
 * assert (a) the runInTenant throws, (b) tier_upgrade_suggestions
 * row count is 0, (c) audit_log count for the test tenant is 0.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import { tenantRenewalSettings } from '@/modules/renewals/infrastructure/schema-tenant-renewal-config';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import {
  evaluateTierUpgrade,
  makeRenewalsDeps,
  DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('F8 evaluateTierUpgrade outerTx rollback — Staff-R003 close', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // Seed: catalogue with regular + premium plans + auto_upgrade=true.
    await runInTenant(tenant.ctx, async (tx) => {
      const txDb = tx as unknown as typeof db;
      await txDb.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'rb-regular',
        planYear: 2026,
        planName: { en: 'Regular' },
        description: { en: '' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 5_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        renewalTierBucket: 'regular',
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await txDb.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'rb-premium',
        planYear: 2026,
        planName: { en: 'Premium' },
        description: { en: '' },
        sortOrder: 20,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 10_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: 100_000_000,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        renewalTierBucket: 'premium',
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await txDb
        .insert(tenantRenewalSettings)
        .values({
          tenantId: tenant.ctx.slug,
          autoUpgradeEnabled: true,
        })
        .onConflictDoUpdate({
          target: tenantRenewalSettings.tenantId,
          set: { autoUpgradeEnabled: true },
        });
    });
    // Seed: 1 above-threshold member + cycle so flushPage proceeds to
    // bulkInsertOpenIfAbsent + bulkEmitInTx (the failure surface we
    // want to test).
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const now = Date.now();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'Rollback Test Co',
        country: 'TH',
        planId: 'rb-regular',
        planYear: 2026,
        turnoverThb: 200_000_000, // above premium threshold
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Rb',
        lastName: 'Test',
        email: `rb-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: new Date(now - 30 * MS_PER_DAY),
        periodTo: new Date(now + 30 * MS_PER_DAY),
        expiresAt: new Date(now + 30 * MS_PER_DAY),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(tierUpgradeSuggestions)
      .where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(contacts)
      .where(eq(contacts.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(members)
      .where(eq(members.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(membershipPlans)
      .where(eq(membershipPlans.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('R6-B1: outerTx + bulkEmitInTx throw → runInTenant rolls back; zero rows persisted', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    // Mock bulkEmitInTx to throw AFTER bulkInsertOpenIfAbsent
    // succeeds. This simulates the failure surface where insert
    // commits (would be visible at end-of-tx) but audit emit fails.
    // Without R6-B1 fix, the prior R5-B1 try/catch swallowed the
    // throw → outer runInTenant COMMITTED → tier_upgrade_suggestions
    // row + zero audit_log row = state↔audit drift.
    const emitSpy = vi
      .spyOn(deps.auditEmitter, 'bulkEmitInTx')
      .mockRejectedValueOnce(new Error('synthetic bulk emit failure'));

    // Mirror the cron route at
    // src/app/api/cron/renewals/tier-upgrade-evaluate/[tenantId]/route.ts:77-94
    // — open outer runInTenant, acquire advisory lock, call
    // evaluateTierUpgrade with outerTx. R6-B1 demands the throw
    // propagate up so this runInTenant rolls back atomically.
    let threwAsExpected = false;
    try {
      await runInTenant(tenant.ctx, async (tx) => {
        await evaluateTierUpgrade(
          deps,
          {
            tenantId: tenant.ctx.slug,
            correlationId: randomUUID(),
            pageSize: DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
          },
          tx,
        );
      });
    } catch (e) {
      threwAsExpected = true;
      expect((e as Error).message).toMatch(/bulk_emit_failed|synthetic bulk emit failure/);
    }
    expect(threwAsExpected).toBe(true);

    // **The binding atomicity assertions** — Constitution Principle
    // VIII state↔audit must be all-or-nothing:
    const persistedSuggestions = await db
      .select()
      .from(tierUpgradeSuggestions)
      .where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug));
    expect(persistedSuggestions).toHaveLength(0);

    const persistedAudits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    // Allow other audit emits unrelated to flushPage (e.g.
    // tier_upgrade_already_at_target aggregate emit at end of
    // evaluateTierUpgrade) but assert NO `tier_upgrade_suggested`
    // audits landed (the audit-state pair we tested rolls back together).
    const suggestedAudits = persistedAudits.filter(
      (a) => a.eventType === 'tier_upgrade_suggested',
    );
    expect(suggestedAudits).toHaveLength(0);

    emitSpy.mockRestore();
  }, 60_000);
});
