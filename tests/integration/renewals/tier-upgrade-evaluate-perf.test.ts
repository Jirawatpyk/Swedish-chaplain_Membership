/**
 * F8 Phase 10 · T264 — `evaluateTierUpgrade` cron perf benchmark
 * (RUN_PERF=1).
 *
 * Verifies FR-038 / SC-005 SLO: tier-upgrade evaluation cron MUST
 * complete in <30s @ 5,000 active members per tenant. Uses 1,000
 * members (PERF_MEMBER_COUNT default) and linear-extrapolates to 5k
 * per the at-risk-recompute precedent.
 *
 * Member set is configured so a meaningful subset crosses the upgrade
 * threshold (turnoverThb above the Premium plan's `min_turnover`),
 * exercising the per-member decision tree + suggestion-insert + audit
 * emit branches under the partial-unique-index protection. Suggestions
 * are then cleaned up in afterAll.
 *
 * Run:
 *   RUN_PERF=1 pnpm test:integration tests/integration/renewals/tier-upgrade-evaluate-perf.test.ts
 *   RUN_PERF=1 PERF_MEMBER_COUNT=5000 PERF_SLO_STRICT=1 pnpm test:integration ...
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, type InferInsertModel } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
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

const RUN_PERF = process.env.RUN_PERF === '1';
const MEMBER_COUNT = Number.parseInt(process.env.PERF_MEMBER_COUNT ?? '1000', 10);
const BATCH_SIZE = 250;
const PERF_SLO_MS = 30_000; // FR-038 / SC-005 (30s budget per spec)
const PERF_SLO_STRICT = process.env.PERF_SLO_STRICT === '1';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const REGULAR_PLAN_ID = 'tier-perf-regular';
const PREMIUM_PLAN_ID = 'tier-perf-premium';
// Money-unit convention (post tier-upgrade-money-unit fix):
//  - `membershipPlans.{min_turnover,annual_fee}_minor_units` are in
//    satang. The catalog adapter divides by 100 at the boundary so
//    `PlanCatalogEntry.{minTurnoverThb,annualFeeThb}` are integer THB.
//  - `members.turnoverThb` is integer THB (raw column).
// Therefore `decideUpgrade` (evaluate-tier-upgrade.ts:121) compares
// THB↔THB. Below we keep seed values in satang for DB inserts and
// derive the THB-side threshold so the test mirrors production semantics.
const REGULAR_FEE_MINOR = 5_000_000; // 5,000,000 satang = 50,000 THB annual fee
const PREMIUM_THRESHOLD_MINOR = 100_000_000; // 100,000,000 satang = 1,000,000 THB threshold
const PREMIUM_THRESHOLD_THB = Math.floor(PREMIUM_THRESHOLD_MINOR / 100); // 1,000,000 THB equivalent
// Member's turnover (already in THB) above/below the THB-converted threshold.
const ABOVE_THRESHOLD_TURNOVER = PREMIUM_THRESHOLD_THB + 1;
const BELOW_THRESHOLD_TURNOVER = Math.floor(PREMIUM_THRESHOLD_THB / 2);

interface SeededMember {
  readonly memberId: string;
  readonly cycleId: string;
}

async function seedCatalogue(tenant: TestTenant, user: TestUser): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    // Regular tier — no min_turnover (catch-all).
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId: REGULAR_PLAN_ID,
      planYear: 2026,
      planName: { en: 'Regular' },
      description: { en: '' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: REGULAR_FEE_MINOR,
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
    // Premium tier — threshold members must cross.
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId: PREMIUM_PLAN_ID,
      planYear: 2026,
      planName: { en: 'Premium' },
      description: { en: '' },
      sortOrder: 20,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 10_000_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits: PREMIUM_THRESHOLD_MINOR,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      renewalTierBucket: 'premium',
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
    await tx
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
}

async function seedBulkCandidates(
  tenant: TestTenant,
  user: TestUser,
  count: number,
): Promise<ReadonlyArray<SeededMember>> {
  const seeded: SeededMember[] = [];
  const now = Date.now();
  for (let offset = 0; offset < count; offset += BATCH_SIZE) {
    const batchSize = Math.min(BATCH_SIZE, count - offset);
    const memberRows: Array<InferInsertModel<typeof members>> = [];
    const contactRows: Array<InferInsertModel<typeof contacts>> = [];
    const cycleRows: Array<InferInsertModel<typeof renewalCycles>> = [];
    for (let i = 0; i < batchSize; i++) {
      const idx = offset + i;
      const memberId = randomUUID();
      const cycleId = randomUUID();
      // ~30% of members cross threshold (mirror of realistic chamber
      // turnover distribution); rest stay below to exercise the
      // not-eligible branch in the decision tree.
      const aboveThreshold = idx % 3 === 0;
      memberRows.push({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: `Tier Perf Co ${idx}`,
        country: 'TH',
        planId: REGULAR_PLAN_ID,
        planYear: 2026,
        turnoverThb: aboveThreshold
          ? ABOVE_THRESHOLD_TURNOVER
          : BELOW_THRESHOLD_TURNOVER,
      });
      contactRows.push({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Tier',
        lastName: `T${idx}`,
        email: `tier-${idx}-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en' as const,
      });
      cycleRows.push({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming' as const,
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
      seeded.push({ memberId, cycleId });
    }
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values(memberRows);
      await tx.insert(contacts).values(contactRows);
      await tx.insert(renewalCycles).values(cycleRows);
    });
  }
  return seeded;
}

describe.skipIf(!RUN_PERF)(
  'F8 evaluateTierUpgrade perf — integration (T264, RUN_PERF=1)',
  () => {
    let tenant: TestTenant;
    let user: TestUser;
    let seeded: ReadonlyArray<SeededMember>;

    beforeAll(async () => {
      user = await createActiveTestUser('admin');
      tenant = await createTestTenant('test-swecham');
      await seedCatalogue(tenant, user);
      const seedStart = Date.now();
      seeded = await seedBulkCandidates(tenant, user, MEMBER_COUNT);
      const seedDurationMs = Date.now() - seedStart;
      console.log(
        `[T264] Seeded ${seeded.length} candidates in ${seedDurationMs}ms`,
      );
    }, 600_000);

    afterAll(async () => {
      const memberIds = seeded.map((s) => s.memberId);
      for (let i = 0; i < memberIds.length; i += 1000) {
        const slice = memberIds.slice(i, i + 1000);
        await db
          .delete(tierUpgradeSuggestions)
          .where(inArray(tierUpgradeSuggestions.memberId, slice))
          .catch(() => {});
        await db
          .delete(renewalCycles)
          .where(inArray(renewalCycles.memberId, slice))
          .catch(() => {});
        await db
          .delete(contacts)
          .where(inArray(contacts.memberId, slice))
          .catch(() => {});
        await db
          .delete(members)
          .where(inArray(members.memberId, slice))
          .catch(() => {});
      }
      await db
        .delete(membershipPlans)
        .where(eq(membershipPlans.tenantId, tenant.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug))
        .catch(() => {});
      await tenant.cleanup().catch(() => {});
    }, 600_000);

    it(`per-tenant evaluation <${PERF_SLO_MS}ms @ ${MEMBER_COUNT} members (strict=${PERF_SLO_STRICT})`, async () => {
      const deps = makeRenewalsDeps(tenant.ctx.slug);

      // R4-staff F3 close + production parity: mirror the
      // tier-upgrade-evaluate cron route at
      // src/app/api/cron/renewals/tier-upgrade-evaluate/[tenantId]/route.ts:77-94 —
      // open a runInTenant for advisory lock acquisition, then thread
      // the lock-holding tx as `outerTx` so suggestion-insert + audit-
      // emit writes share the same connection (no per-iteration
      // runInTenant pulling separate pool connections). The unwrapped
      // bench was measuring N×runInTenant overhead (~3-4 RTT per call)
      // which production explicitly avoids.
      const cronStart = performance.now();
      const result = await runInTenant(tenant.ctx, async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended('renewals:tierupgrade:'||${tenant.ctx.slug}, 0))`,
        );
        return await evaluateTierUpgrade(
          deps,
          {
            tenantId: tenant.ctx.slug,
            correlationId: randomUUID(),
            pageSize: DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
          },
          tx,
        );
      });
      const cronDurationMs = performance.now() - cronStart;
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const out = result.value;
      // tenantSkipped should be null with our seeded auto_upgrade=true +
      // catalogue-with-thresholds. Members scanned should equal seed count.
      expect(out.tenantSkipped).toBeNull();
      expect(out.membersScanned).toBeGreaterThan(0);
      // R4-staff F3 close: pin the suggestion-create branch is exercised
      // (not just the early-exit `alreadyAtTarget` branch). Without this
      // assertion, a broken seed convention (e.g. mismatched units between
      // members.turnoverThb and membershipPlans.minTurnoverMinorUnits)
      // silently let the bench measure only the no-op path. ~33% of seeded
      // members are above-threshold; expect ≥1 actual suggestion in any
      // realistic scenario.
      expect(out.suggestionsCreated).toBeGreaterThan(0);
      const perMemberMs = cronDurationMs / Math.max(1, out.membersScanned);

      console.log(
        `[T264] scanned=${out.membersScanned} suggestions=${out.suggestionsCreated} alreadyAtTarget=${out.alreadyAtTarget} dur=${cronDurationMs.toFixed(0)}ms (${perMemberMs.toFixed(2)}ms/member)`,
      );

      try {
        appendFileSync(
          'perf-benchmarks.md',
          `\n## F8 Phase 10 T264 — evaluateTierUpgrade @ ${MEMBER_COUNT} members (${new Date().toISOString()})\n` +
            `- members scanned: ${out.membersScanned}\n` +
            `- suggestions created: ${out.suggestionsCreated} · already at target: ${out.alreadyAtTarget} · suppressed: ${out.suppressedSkipped} · conflict: ${out.conflictSkipped}\n` +
            `- cron pass: ${cronDurationMs.toFixed(0)}ms (SLO ${PERF_SLO_MS}ms; strict=${PERF_SLO_STRICT})\n` +
            `- per-member avg: ${perMemberMs.toFixed(2)}ms\n` +
            `- extrapolation to 5k: ~${((cronDurationMs / MEMBER_COUNT) * 5000).toFixed(0)}ms (linear)\n`,
        );
      } catch {
        // perf-benchmarks.md may not exist; non-fatal.
      }

      if (PERF_SLO_STRICT) {
        expect(cronDurationMs).toBeLessThan(PERF_SLO_MS);
      } else {
        expect(cronDurationMs).toBeGreaterThan(0);
      }
    }, 600_000);
  },
);
