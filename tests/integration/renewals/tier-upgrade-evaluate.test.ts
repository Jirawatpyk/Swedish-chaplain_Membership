/**
 * F8 Phase 7 T202 — Tier-upgrade evaluate cron — integration (live Neon).
 *
 * Verifies the FR-037 + FR-038 + AS1 + AS4 + AS5 + AS6 cron flow
 * against a live Neon ap-southeast-1 tenant. Test scope:
 *
 *   1. Happy path — Regular-tier member with turnover crossing
 *      Premium threshold ⇒ `tier_upgrade_suggested` audit + open row.
 *   2. Idempotency (AS1) — re-running the cron does NOT insert a
 *      duplicate (member_open partial UNIQUE blocks it).
 *   3. Already-at-target (AS4) — member already on the highest plan
 *      they qualify for ⇒ `tier_upgrade_already_at_target` debug
 *      signal + zero suggestions inserted.
 *   4. Tenant-disabled (AS6) — `auto_upgrade_enabled = false` ⇒ tenant
 *      skipped + `tier_upgrade_tenant_disabled` audit.
 *   5. No-thresholds (AS5) — tenant catalogue has zero `min_turnover`
 *      ⇒ `tier_upgrade_skipped_no_thresholds_configured` audit.
 *   6. Suppression (AS3) — `dismissed` row with `suppressed_until` in
 *      future ⇒ cron skips that member.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
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

// 055-member-number — raw member seeds (bypassing the createMember allocator)
// must supply a distinct positive `member_number` per the NOT NULL + per-tenant
// UNIQUE index. Monotonic counter keeps every seed in the shared test tenant
// collision-free.
let memberNumberSeq = 0;
function nextMemberNumber(): number {
  memberNumberSeq += 1;
  return memberNumberSeq;
}

interface SeededMember {
  readonly memberId: string;
  readonly cycleId: string;
}

async function seedMember(
  tenant: TestTenant,
  user: TestUser,
  opts: {
    readonly planId: string;
    readonly turnoverThb: number | null;
  },
): Promise<SeededMember> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const now = Date.now();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextMemberNumber(),
      companyName: 'Test Co',
      country: 'TH',
      planId: opts.planId,
      planYear: 2026,
      turnoverThb: opts.turnoverThb,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Test',
      lastName: 'Person',
      email: `tu-${randomUUID().slice(0, 6)}@acme.example`,
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
    void user; // helper artefact
  });
  return { memberId, cycleId };
}

async function seedPlan(
  tenant: TestTenant,
  user: TestUser,
  opts: {
    readonly planId: string;
    readonly tierBucket: string;
    readonly minTurnoverMinorUnits: number | null;
    readonly annualFeeMinorUnits?: number;
  },
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId: opts.planId,
      planYear: 2026,
      planName: { en: opts.planId },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: opts.annualFeeMinorUnits ?? 5_000_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits: opts.minTurnoverMinorUnits,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      renewalTierBucket: opts.tierBucket,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
  });
}

async function setAutoUpgradeEnabled(
  tenant: TestTenant,
  enabled: boolean,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx
      .insert(tenantRenewalSettings)
      .values({
        tenantId: tenant.ctx.slug,
        autoUpgradeEnabled: enabled,
      })
      .onConflictDoUpdate({
        target: tenantRenewalSettings.tenantId,
        set: { autoUpgradeEnabled: enabled },
      });
  });
}

async function clearTenant(tenant: TestTenant): Promise<void> {
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
  await db
    .delete(tenantRenewalSettings)
    .where(eq(tenantRenewalSettings.tenantId, tenant.ctx.slug))
    .catch(() => {});
}

describe('F8 tier-upgrade evaluate — integration (T202)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 180_000);

  afterAll(async () => {
    await clearTenant(tenant).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    await clearTenant(tenant);
  });

  it('happy path — eligible member produces a tier_upgrade_suggested + open row', async () => {
    // 100M THB threshold for premium; member declares 120M.
    await seedPlan(tenant, admin, {
      planId: 'regular',
      tierBucket: 'regular',
      minTurnoverMinorUnits: 50_000_000,
    });
    await seedPlan(tenant, admin, {
      planId: 'premium',
      tierBucket: 'premium',
      minTurnoverMinorUnits: 100_000_000,
    });
    const seeded = await seedMember(tenant, admin, {
      planId: 'regular',
      turnoverThb: 120_000_000,
    });
    await setAutoUpgradeEnabled(tenant, true);

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await evaluateTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
      pageSize: DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tenantSkipped).toBeNull();
    expect(result.value.suggestionsCreated).toBe(1);

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(tierUpgradeSuggestions),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memberId).toBe(seeded.memberId);
    expect(rows[0]?.fromPlanId).toBe('regular');
    expect(rows[0]?.toPlanId).toBe('premium');
    expect(rows[0]?.status).toBe('open');

    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_suggested'))
        .orderBy(desc(auditLog.timestamp))
        .limit(5),
    );
    // Staff-R008 fix: exact-count assertion. Each test owns a fresh
    // UUID-suffixed tenant via createTestTenant — runInTenant scopes
    // the query via RLS to that tenant, so prior tests' audits cannot
    // pollute this count. Greater-than-or-equal-1 hid the regression
    // class where the cron dispatched 2 suggestions silently (e.g.
    // pagination boundary bug); exact-count catches it.
    expect(audits).toHaveLength(1);
  }, 60_000);

  it('idempotent — re-running the cron does not duplicate', async () => {
    await seedPlan(tenant, admin, {
      planId: 'regular',
      tierBucket: 'regular',
      minTurnoverMinorUnits: 50_000_000,
    });
    await seedPlan(tenant, admin, {
      planId: 'premium',
      tierBucket: 'premium',
      minTurnoverMinorUnits: 100_000_000,
    });
    await seedMember(tenant, admin, {
      planId: 'regular',
      turnoverThb: 120_000_000,
    });
    await setAutoUpgradeEnabled(tenant, true);
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const first = await evaluateTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
      pageSize: DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.suggestionsCreated).toBe(1);

    const second = await evaluateTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
      pageSize: DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.suggestionsCreated).toBe(0);
    // Phase 10 T262 batched-write fix — the idempotency contract is
    // ROW-LEVEL (no duplicate suggestion_row INSERT), NOT scan-level.
    // The eval candidate query at
    // `src/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-eval-candidate-repo.ts`
    // does NOT filter members with an active suggestion (the Round-6
    // S-005 comment claimed it did, but inspection of the query +
    // Phase-10 verify confirmed otherwise — pre-existing test bug
    // never caught by CI because this test isn't in the curated CI
    // integration-suite at `.github/workflows/multi-tenant-readiness.yml`).
    // Real second-pass behaviour: re-scan the member, decide upgrade,
    // attempt bulk-insert, and the partial UNIQUE
    // `tier_upgrade_suggestions_member_open_uniq` rejects → counted
    // as `conflictSkipped`. The DB-row count IS the binding
    // idempotency invariant.
    expect(second.value.membersScanned).toBe(1);
    expect(second.value.conflictSkipped).toBe(1);
    expect(second.value.alreadyAtTarget).toBe(0);
    expect(second.value.suppressedSkipped).toBe(0);
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(tierUpgradeSuggestions),
    );
    // The binding idempotency invariant — no duplicate row was
    // INSERTed despite the loop re-scanning + attempting bulk-insert.
    expect(rows).toHaveLength(1);
  }, 60_000);

  it('tenant-disabled — auto_upgrade_enabled=false skips entire cron pass', async () => {
    await seedPlan(tenant, admin, {
      planId: 'regular',
      tierBucket: 'regular',
      minTurnoverMinorUnits: 50_000_000,
    });
    await seedPlan(tenant, admin, {
      planId: 'premium',
      tierBucket: 'premium',
      minTurnoverMinorUnits: 100_000_000,
    });
    await seedMember(tenant, admin, {
      planId: 'regular',
      turnoverThb: 120_000_000,
    });
    await setAutoUpgradeEnabled(tenant, false);

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await evaluateTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
      pageSize: DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tenantSkipped).toEqual({
      reason: 'tenant_disabled',
    });
    expect(result.value.suggestionsCreated).toBe(0);

    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_tenant_disabled'))
        .limit(5),
    );
    // Staff-R008 fix: exact-count.
    expect(audits).toHaveLength(1);
  }, 60_000);

  it('no-thresholds — catalogue without min_turnover skips with audit', async () => {
    await seedPlan(tenant, admin, {
      planId: 'regular',
      tierBucket: 'regular',
      minTurnoverMinorUnits: null,
    });
    await seedMember(tenant, admin, {
      planId: 'regular',
      turnoverThb: 120_000_000,
    });
    await setAutoUpgradeEnabled(tenant, true);

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await evaluateTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
      pageSize: DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tenantSkipped).toEqual({
      reason: 'no_thresholds_configured',
    });

    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          eq(auditLog.eventType, 'tier_upgrade_skipped_no_thresholds_configured'),
        )
        .limit(5),
    );
    // Staff-R008 fix: exact-count.
    expect(audits).toHaveLength(1);
  }, 60_000);

  it('R3-IMP-8 — no_plans skip_reason discriminator (catalogue empty)', async () => {
    // Round 3 review-fix: explicit `no_plans` branch test. Round 2
    // added the discriminator but the original "no-thresholds" test
    // hits `no_thresholds_set` (catalogue populated, thresholds null).
    // Empty catalogue (no plans, no members) — cron reads catalogue
    // FIRST so `hasAnyThreshold === false` short-circuits before any
    // member iteration. No FK violation seeding needed.
    await setAutoUpgradeEnabled(tenant, true);
    // NOTE: do NOT seed any membership_plans — catalogue empty.
    // NOTE: do NOT seed any members — would FK-fail without plans;
    // also unnecessary since the cron's catalogue-empty short-circuit
    // fires before member iteration.

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await evaluateTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
      pageSize: DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tenantSkipped).toEqual({
      reason: 'no_thresholds_configured',
    });

    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          eq(
            auditLog.eventType,
            'tier_upgrade_skipped_no_thresholds_configured',
          ),
        )
        .orderBy(desc(auditLog.timestamp))
        .limit(1),
    );
    // Staff-R008 fix: exact-count.
    expect(audits).toHaveLength(1);
    // R3-IMP-8 payload assertion: skip_reason discriminator present.
    const payload = audits[0]?.payload as { catalogue_size?: number; skip_reason?: string };
    expect(payload?.catalogue_size).toBe(0);
    expect(payload?.skip_reason).toBe('no_plans');
  }, 60_000);

  it('AS4 — member already on highest qualifying plan emits already_at_target audit', async () => {
    // Phase 7 review-fix C-TEST-2: AS4 explicit coverage. Seed a member
    // already on `premium` (the highest plan they qualify for at 120M
    // turnover); evaluate cron should produce zero new suggestions and
    // emit `tier_upgrade_already_at_target` per spec § AS4.
    await seedPlan(tenant, admin, {
      planId: 'regular',
      tierBucket: 'regular',
      minTurnoverMinorUnits: 50_000_000,
    });
    await seedPlan(tenant, admin, {
      planId: 'premium',
      tierBucket: 'premium',
      minTurnoverMinorUnits: 100_000_000,
    });
    // Member is already on premium; their 120M turnover qualifies them
    // for premium but not for any plan above (no higher plan seeded).
    await seedMember(tenant, admin, {
      planId: 'premium',
      turnoverThb: 120_000_000,
    });
    await setAutoUpgradeEnabled(tenant, true);

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await evaluateTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
      pageSize: DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tenantSkipped).toBeNull();
    expect(result.value.suggestionsCreated).toBe(0);
    // The member's plan_id ('premium') is the highest so the decision
    // tree returns null → counted as `alreadyAtTarget` per the
    // use-case decideUpgrade contract.
    // Staff-R008 fix: exact-count. The test seeds exactly 1 member.
    expect(result.value.alreadyAtTarget).toBe(1);

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(tierUpgradeSuggestions),
    );
    expect(rows).toHaveLength(0);

    // R3-IMP-8 + R3-CRIT-3 fix: AS4 audit row assertion. Round 2 IMP-9
    // wired the emit; Round 3 verifies the audit lands in audit_log.
    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_already_at_target')),
    );
    // Staff-R008 fix: exact-count. Round 6 W-010 collapsed the per-
    // member audits into 1 aggregate emit per cron pass; this test
    // runs evaluateTierUpgrade exactly once → expect exactly 1 audit.
    expect(audits).toHaveLength(1);
  }, 60_000);

  it('suppression — dismissed row in last 90d hides the member', async () => {
    await seedPlan(tenant, admin, {
      planId: 'regular',
      tierBucket: 'regular',
      minTurnoverMinorUnits: 50_000_000,
    });
    await seedPlan(tenant, admin, {
      planId: 'premium',
      tierBucket: 'premium',
      minTurnoverMinorUnits: 100_000_000,
    });
    const seeded = await seedMember(tenant, admin, {
      planId: 'regular',
      turnoverThb: 120_000_000,
    });
    await setAutoUpgradeEnabled(tenant, true);

    // Seed a `dismissed` suggestion with `suppressed_until` 30d in future.
    const futureSuppressUntil = new Date(Date.now() + 30 * MS_PER_DAY);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tierUpgradeSuggestions).values({
        tenantId: tenant.ctx.slug,
        suggestionId: randomUUID(),
        memberId: seeded.memberId,
        fromPlanId: 'regular',
        toPlanId: 'premium',
        reasonCode: 'declared_turnover_above_threshold',
        evidenceJsonb: {
          reasonCode: 'declared_turnover_above_threshold',
          turnoverThb: 120_000_000,
          thresholdMetAt: new Date().toISOString(),
        },
        status: 'dismissed',
        dismissedReason: 'admin_decided_no',
        suppressedUntil: futureSuppressUntil,
        closedAt: new Date(),
      });
    });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await evaluateTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
      pageSize: DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestionsCreated).toBe(0);
    // Staff-R008 fix: exact-count. The test seeds exactly 1 suppressed
    // member (line 506-543); a regression that double-counted
    // suppressions would now fail.
    expect(result.value.suppressedSkipped).toBe(1);
  }, 60_000);

  // Reference unused import for symmetry — `and` + `sql` may be used in
  // additional asserts as the test surface grows.
  void and;
  void sql;
});
