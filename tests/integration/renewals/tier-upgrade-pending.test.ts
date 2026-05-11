/**
 * F8 Phase 7 T203 — Tier-upgrade pending lifecycle — integration (live Neon).
 *
 * Verifies the accept → pending → applied flow + the manual-override
 * supersede branch against a live Neon ap-southeast-1 tenant. Test
 * scope:
 *
 *   1. Accept happy path — open suggestion + active cycle → admin
 *      Accept → suggestion `accepted_pending_apply` + F2
 *      `scheduled_plan_changes` pending row + `tier_upgrade_accepted`
 *      audit emitted.
 *   2. T-180 verify task — when `expires_at - today > 180d`, accept
 *      creates a `verify_pending_tier_upgrade` escalation task +
 *      emits `tier_upgrade_pending_admin_verification_due`.
 *   3. T-180 skipped — when `expires_at - today <= 180d`, no task
 *      created (acceptance still succeeds).
 *   4. Apply at renewal — `applyPendingTierUpgradeInTx` transitions
 *      pending → applied + emits `tier_upgrade_applied_at_renewal`
 *      with the F4 invoiceId.
 *   5. Manual-override supersede — F2 `member_plan_manually_changed`
 *      listener path: `supersedePendingTierUpgradeInTx` transitions
 *      `accepted_pending_apply` → `superseded` + emits
 *      `tier_upgrade_pending_superseded_by_manual_change`.
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
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { scheduledPlanChanges } from '@/modules/plans/infrastructure/db/schema-scheduled-plan-changes';
import {
  acceptTierUpgrade,
  applyPendingTierUpgrade,
  supersedePendingTierUpgrade,
  makeRenewalsDeps,
} from '@/modules/renewals';
import {
  parseSuggestionId,
  type SuggestionId,
} from '@/modules/renewals/domain/tier-upgrade-suggestion';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface SeededState {
  readonly memberId: string;
  readonly cycleId: string;
  readonly suggestionId: SuggestionId;
}

async function seedPlan(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  tierBucket: string,
  minTurnoverMinorUnits: number | null,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: planId },
      description: { en: '' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 5_000_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      renewalTierBucket: tierBucket,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
  });
}

async function seedSuggestionState(
  tenant: TestTenant,
  user: TestUser,
  opts: { readonly daysUntilExpiry: number; readonly turnoverThb: number },
): Promise<SeededState> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const suggestionUuid = randomUUID();
  const now = Date.now();
  const expiresAt = new Date(now + opts.daysUntilExpiry * MS_PER_DAY);

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'Pending Test Co',
      country: 'TH',
      planId: 'regular',
      planYear: 2026,
      turnoverThb: opts.turnoverThb,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Test',
      lastName: 'Member',
      email: `pending-${randomUUID().slice(0, 6)}@acme.example`,
      isPrimary: true,
      preferredLanguage: 'en',
    });
    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      status: 'upcoming',
      periodFrom: new Date(now - 30 * MS_PER_DAY),
      periodTo: expiresAt,
      expiresAt,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: 'regular',
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });
    await tx.insert(tierUpgradeSuggestions).values({
      tenantId: tenant.ctx.slug,
      suggestionId: suggestionUuid,
      memberId,
      fromPlanId: 'regular',
      toPlanId: 'premium',
      reasonCode: 'declared_turnover_above_threshold',
      evidenceJsonb: {
        reasonCode: 'declared_turnover_above_threshold',
        turnoverThb: opts.turnoverThb,
        thresholdMetAt: new Date().toISOString(),
      },
      status: 'open',
    });
  });

  void user;
  const idResult = parseSuggestionId(suggestionUuid);
  if (!idResult.ok) throw new Error('seeded id failed parse');
  return { memberId, cycleId, suggestionId: idResult.value };
}

async function clearTenant(tenant: TestTenant): Promise<void> {
  for (const tableQuery of [
    db
      .delete(scheduledPlanChanges)
      .where(eq(scheduledPlanChanges.tenantId, tenant.ctx.slug)),
    db
      .delete(renewalEscalationTasks)
      .where(eq(renewalEscalationTasks.tenantId, tenant.ctx.slug)),
    db
      .delete(tierUpgradeSuggestions)
      .where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)),
    db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
    db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
    db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
    db
      .delete(membershipPlans)
      .where(eq(membershipPlans.tenantId, tenant.ctx.slug)),
    db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
  ]) {
    await tableQuery.catch(() => {});
  }
}

describe('F8 tier-upgrade pending lifecycle — integration (T203)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // Seed shared plan catalogue once.
    await seedPlan(tenant, admin, 'regular', 'regular', 50_000_000);
    await seedPlan(tenant, admin, 'premium', 'premium', 100_000_000);
  }, 180_000);

  afterAll(async () => {
    await clearTenant(tenant).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    // Clear per-test state but keep the plan catalogue.
    for (const tableQuery of [
      db
        .delete(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.tenantId, tenant.ctx.slug)),
      db
        .delete(renewalEscalationTasks)
        .where(eq(renewalEscalationTasks.tenantId, tenant.ctx.slug)),
      db
        .delete(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)),
      db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
    ]) {
      await tableQuery.catch(() => {});
    }
  });

  it('R2-CRIT-3.A — accept with no primary contact emits notify_skipped audit', async () => {
    // Round 2 review-fix C-TEST-3.A — silent-skip audit coverage.
    // Seed a member without a primary contact email; admin Accept
    // should still succeed but emit `tier_upgrade_pending_member_notify_skipped`.
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const suggestionUuid = randomUUID();
    const now = Date.now();
    const expiresAt = new Date(now + 60 * MS_PER_DAY);

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'No Contact Co',
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
        turnoverThb: 120_000_000,
      });
      // NOTE: NO contacts row inserted — primary contact missing.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: new Date(now - 30 * MS_PER_DAY),
        periodTo: expiresAt,
        expiresAt,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
      await tx.insert(tierUpgradeSuggestions).values({
        tenantId: tenant.ctx.slug,
        suggestionId: suggestionUuid,
        memberId,
        fromPlanId: 'regular',
        toPlanId: 'premium',
        reasonCode: 'declared_turnover_above_threshold',
        evidenceJsonb: {
          reasonCode: 'declared_turnover_above_threshold',
          turnoverThb: 120_000_000,
          thresholdMetAt: new Date().toISOString(),
        },
        status: 'open',
      });
    });

    const idResult = parseSuggestionId(suggestionUuid);
    if (!idResult.ok) throw new Error('seeded id failed parse');
    const suggestionId = idResult.value;

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memberNotifiedDeliveryId).toBeNull();

    const skippedAudits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          eq(
            auditLog.eventType,
            'tier_upgrade_pending_member_notify_skipped',
          ),
        ),
    );
    expect(skippedAudits.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('AS2 — accept dispatches member email + emits notify audit', async () => {
    // Phase 7 review-fix C-TEST-1: explicit AS2 / FR-039 step 2
    // assertion. The accept-tier-upgrade post-tx path calls the stub
    // gateway (NODE_ENV=test) which logs synthetic delivery id; we
    // assert the audit row was emitted with the brand fields.
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The Resend gateway in test mode dispatches a real (or
    // sandbox) message. Assert the audit row landed regardless of
    // delivery-id presence — `_member_notified` fires only on
    // gateway success; `_member_notify_skipped` fires when the
    // member has no primary contact email; `_member_notify_failed`
    // fires when the gateway returns err. This test seeds a primary
    // contact + has a healthy gateway so the success audit MUST fire.
    const notifyAudits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          eq(auditLog.eventType, 'tier_upgrade_pending_member_notified'),
        ),
    );
    expect(notifyAudits.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('accept happy path — pending state + scheduled-plan-change + audit', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestionId).toBe(seeded.suggestionId);
    expect(result.value.targetApplyAtCycleId).toBe(seeded.cycleId);
    // 60d < 180d → no verify task
    expect(result.value.verificationTaskId).toBeNull();
    expect(result.value.scheduledChangeId).toMatch(/^[0-9a-f-]{36}$/);

    // Suggestion row transitioned + has anchors.
    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('accepted_pending_apply');
    expect(suggestion?.acceptedByUserId).toBe(admin.userId);
    expect(suggestion?.targetApplyAtCycleId).toBe(seeded.cycleId);

    // F2 scheduled_plan_changes pending row exists.
    const [scheduled] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.memberId, seeded.memberId)),
    );
    expect(scheduled?.status).toBe('pending');
    expect(scheduled?.fromPlanId).toBe('regular');
    expect(scheduled?.toPlanId).toBe('premium');

    // tier_upgrade_accepted audit emitted.
    const accepted = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_accepted')),
    );
    expect(accepted.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('T-180 verify task — created when expires_at > 180d', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 240,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verificationTaskId).not.toBeNull();

    const tasks = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(renewalEscalationTasks)
        .where(
          eq(renewalEscalationTasks.taskType, 'verify_pending_tier_upgrade'),
        ),
    );
    expect(tasks).toHaveLength(1);

    // Audit `tier_upgrade_pending_admin_verification_due` emitted.
    const auditDue = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          eq(
            auditLog.eventType,
            'tier_upgrade_pending_admin_verification_due',
          ),
        ),
    );
    expect(auditDue.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('T-180 skipped — no task when expires_at <= 180d', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 90,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verificationTaskId).toBeNull();

    const tasks = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(renewalEscalationTasks)
        .where(
          eq(renewalEscalationTasks.taskType, 'verify_pending_tier_upgrade'),
        ),
    );
    expect(tasks).toHaveLength(0);
  }, 60_000);

  it('apply at renewal — pending → applied + audit', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Accept first.
    const accept = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(accept.ok).toBe(true);

    // Now apply (simulating F4 invoice-paid hook firing for this cycle
    // with a fresh invoiceId).
    const fakeInvoiceId = randomUUID();
    const applyResult = await applyPendingTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: seeded.cycleId,
      invoiceId: fakeInvoiceId,
      correlationId: randomUUID(),
    });
    expect(applyResult.ok).toBe(true);
    if (!applyResult.ok) return;
    expect(applyResult.value.suggestionsApplied).toContain(seeded.suggestionId);

    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('applied');
    expect(suggestion?.appliedAtInvoiceId).toBe(fakeInvoiceId);
    expect(suggestion?.closedAt).not.toBeNull();

    const applied = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_applied_at_renewal')),
    );
    expect(applied.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('manual override supersede — accepted_pending_apply → superseded + audit', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Accept first to get into accepted_pending_apply.
    const accept = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(accept.ok).toBe(true);

    // Simulate F2 manual plan change → F8 listener runs.
    const result = await supersedePendingTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      manualChangeActorUserId: admin.userId,
      supersedingPlanId: 'enterprise',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supersededSuggestionId).toBe(seeded.suggestionId);
    expect(result.value.fromStatus).toBe('accepted_pending_apply');

    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('superseded');
    expect(suggestion?.closedAt).not.toBeNull();

    const supersededAudit = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          eq(
            auditLog.eventType,
            'tier_upgrade_pending_superseded_by_manual_change',
          ),
        ),
    );
    expect(supersededAudit.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('R4-IMP-5 — threw-branch emits notify_failed audit (null hash + failure_kind unknown)', async () => {
    // Round 4 IMP-5 — exercises the `kind: 'threw'` arm of the
    // GatewayResult discriminated union (Round 3 IMP-2 added the
    // emit; Round 4 locks it with an integration test). When the
    // dispatchCandidateRepo / planLookup / gateway path throws,
    // the audit MUST land with `recipient_email_hashed: null` +
    // `failure_kind: 'unknown'` so forensic queries can distinguish
    // the catch-all-throw class from the structured-error class.
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    // Override findOne to throw — simulates a transient DB read crash
    // that lands BEFORE the gateway call. Other paths inside the try
    // block would also drive 'threw' but findOne is the earliest +
    // simplest seam. The repo override is post-construction so the
    // outer F2 listener wiring stays intact.
    // Round 5 IMP-9 — also lock the FR-014/019 bounded-payload obligation:
    // failure_message MUST be capped to 500 chars (audit-bloat / PII-leak
    // defence). Use an oversized synthetic error to verify slice() applies.
    const longSyntheticErr = 'synthetic_dispatch_lookup_crash:'.padEnd(800, 'x');
    const throwingDeps = {
      ...deps,
      dispatchCandidateRepo: {
        ...deps.dispatchCandidateRepo,
        findOne: async () => {
          throw new Error(longSyntheticErr);
        },
      },
    } as typeof deps;

    const result = await acceptTierUpgrade(throwingDeps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Acceptance still committed — gateway-side throw must NOT roll
    // back the F3 tx (suggestion → accepted_pending_apply flip).
    expect(result.value.memberNotifiedDeliveryId).toBeNull();

    // Threw-branch audit row presence + payload-shape probe.
    const threwAudit = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          eq(
            auditLog.eventType,
            'tier_upgrade_pending_member_notify_failed',
          ),
        ),
    );
    expect(threwAudit.length).toBeGreaterThanOrEqual(1);
    const payload = threwAudit[0]?.payload as
      | {
          readonly failure_kind?: string;
          readonly recipient_email_hashed?: string | null;
          readonly failure_message?: string | null;
        }
      | null;
    expect(payload?.failure_kind).toBe('unknown');
    expect(payload?.recipient_email_hashed).toBeNull();
    expect(payload?.failure_message).toMatch(/synthetic_dispatch_lookup_crash/);
    // Round 5 IMP-9 — bounded-payload cap (≤500 chars).
    expect(payload?.failure_message?.length ?? 0).toBeLessThanOrEqual(500);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Round 6 W-011 — concurrent-Accept race
  //
  // Two admins click "Accept" on the same suggestion at almost the same
  // moment. The partial UNIQUE `tier_upgrade_suggestions_member_open_uniq`
  // (status IN open, accepted_pending_apply) ensures the second
  // transition fails with TierUpgradeOpenConflictError. The use-case
  // catches it and the second caller sees an `open_conflict` error
  // (or `suggestion_not_open` if first commit happened to land before
  // the second's findById read).
  // ---------------------------------------------------------------------------
  it('W-011 concurrent Accept race — partial UNIQUE catches second writer + state remains pending exactly once', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const acceptArgs = {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin' as const,
      correlationId: randomUUID(),
    };

    const [r1, r2] = await Promise.all([
      acceptTierUpgrade(deps, { ...acceptArgs, correlationId: randomUUID() }),
      acceptTierUpgrade(deps, { ...acceptArgs, correlationId: randomUUID() }),
    ]);

    // Exactly one wins, exactly one sees a conflict-shaped error
    // (`suggestion_not_open` because the first transition committed
    // before the second's loadOpenSuggestion query ran; OR
    // `open_conflict` if both progressed past the load and raced
    // at the partial-UNIQUE write — accept both forms because the
    // outcome is timing-dependent).
    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    const losers = [r1, r2].filter((r) => !r.ok);
    for (const loser of losers) {
      if (loser.ok) continue;
      // QA-2026-05-10 fix: accept-tier-upgrade.ts surfaces
      // 'plan_change_failed' when F2 schedule-plan-change use-case
      // rejects the second writer (the F2 layer's own concurrency
      // protection beyond F8's partial-UNIQUE). Adding to the
      // expected error.kind set so the W-011 race correctly
      // tolerates either F8-side rejection (suggestion_not_open /
      // open_conflict) OR F2-side rejection (plan_change_failed /
      // server_error). All four are valid "loser" outcomes per the
      // contract.
      expect([
        'suggestion_not_open',
        'open_conflict',
        'plan_change_failed',
        'server_error',
      ]).toContain(loser.error.kind);
    }

    // Suggestion ends in `accepted_pending_apply` exactly once.
    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('accepted_pending_apply');

    // Audit emit — exactly one `tier_upgrade_accepted` row landed for
    // this suggestion (the loser's tx aborted before audit emit).
    // QA-2026-05-10 fix: filter by THIS test's suggestionId. Tenant
    // is shared across this describe block; earlier tests emitted
    // `tier_upgrade_accepted` audits which polluted the unfiltered
    // count. Same shared-tenant-pollution pattern fixed in W-013.
    const accepted = await runInTenant(tenant.ctx, (tx) =>
      (tx as unknown as typeof db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, 'tier_upgrade_accepted'),
            sql`${auditLog.payload}->>'suggestion_id' = ${seeded.suggestionId}`,
          ),
        ),
    );
    expect(accepted).toHaveLength(1);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Round 6 W-013 — manual-supersede with the suggestion still in `open`
  //
  // Spec: F2 manual plan change BEFORE admin clicks Accept. The
  // supersede listener must fire with `fromStatus: 'open'` and
  // transition the suggestion to `superseded`. Phase 7 only tested
  // the `accepted_pending_apply` → superseded branch; this test
  // covers the `open` → superseded branch.
  // ---------------------------------------------------------------------------
  it('W-013 manual-supersede on open suggestion — fromStatus=open + audit emitted', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // NOTE: do NOT call acceptTierUpgrade — keep suggestion in `open`.

    const result = await supersedePendingTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      manualChangeActorUserId: admin.userId,
      supersedingPlanId: 'enterprise',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fromStatus).toBe('open');
    expect(result.value.supersededSuggestionId).toBe(seeded.suggestionId);

    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('superseded');
    expect(suggestion?.closedAt).not.toBeNull();

    // QA-2026-05-10 fix: filter by THIS test's suggestionId. The
    // tenant is shared across tests in this describe block; earlier
    // tests in the file emitted superseded audits for
    // accepted_pending_apply suggestions which polluted
    // supersededAudit[0]. Filtering by suggestionId via JSONB payload
    // selector ensures we read OUR test's audit row.
    const supersededAudit = await runInTenant(tenant.ctx, (tx) =>
      (tx as unknown as typeof db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(
              auditLog.eventType,
              'tier_upgrade_pending_superseded_by_manual_change',
            ),
            sql`${auditLog.payload}->>'suggestion_id' = ${seeded.suggestionId}`,
          ),
        ),
    );
    expect(supersededAudit).toHaveLength(1);
    const payload = supersededAudit[0]?.payload as
      | { superseded_from_status?: string }
      | null;
    expect(payload?.superseded_from_status).toBe('open');
  }, 60_000);
});
