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
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  acceptTierUpgrade,
  applyPendingTierUpgrade,
  supersedePendingTierUpgrade,
  makeRenewalsDeps,
  f8OnPaidCallbacks,
} from '@/modules/renewals';
import { asSatang } from '@/lib/money';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import {
  parseSuggestionId,
  type SuggestionId,
} from '@/modules/renewals/domain/tier-upgrade-suggestion';
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
      description: { en: 'Test description' },
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
      memberNumber: nextMemberNumber(),
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
    // invoices must be deleted AFTER renewal_cycles (cycle→invoice FK)
    // and BEFORE members (invoice→member FK).
    db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
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
      // invoices: AFTER renewal_cycles (cycle→invoice FK), BEFORE members.
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
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
        memberNumber: nextMemberNumber(),
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
  // 065 Fix 1 (W-011b) — deterministic double-accept TOCTOU probe
  //
  // W-011 above is timing-dependent (bare Promise.all race): on most
  // runs the second accepter's `findById` lands AFTER the first's
  // commit, so the loser exits early via `suggestion_not_open` and the
  // stale-read window is never exercised. This probe FORCES the
  // window: accepter #2 reads the suggestion while still `open`, then
  // parks at `cyclesRepo.findActiveForMember` (the call right after
  // `findById`) until accepter #1 has fully committed.
  //
  // Without a compare-and-swap on `transitionStatus`, #2 then
  // re-transitions the already-accepted row → duplicate
  // `tier_upgrade_accepted` audit + duplicate member email +
  // `accepted_by_user_id` overwritten by the last writer. The CAS
  // (`AND status = expectedFrom`) makes #2's UPDATE match 0 rows →
  // `TierUpgradeStatusConflictError` → tx rollback → typed
  // `suggestion_not_open` loser result.
  //
  // 065 S8 (was: known residual) — step-(a)
  // `supersedeAndInsertPendingAtomically` now runs on the OUTER tx, so
  // a CAS-losing accepter rolls its F2 insert back atomically with the
  // F8 transition. The surviving pending `scheduled_plan_changes` row is
  // therefore the WINNER's (#1) — asserted at the end of this test.
  // ---------------------------------------------------------------------------
  it('W-011b deterministic double-accept probe — CAS on transitionStatus rejects the stale-read second accepter', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    // Distinct second admin so the last-writer `accepted_by_user_id`
    // overwrite is observable (both accepts sharing one user id would
    // mask it).
    const admin2 = await createActiveTestUser('admin');
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Gate: #2 signals when it reaches findActiveForMember (its
    // `open` findById read is now stale-able), then parks until
    // released.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });

    const gatedDeps: typeof deps = {
      ...deps,
      cyclesRepo: {
        ...deps.cyclesRepo,
        findActiveForMember: async (tenantId: string, memberId: string) => {
          signalReached();
          await gate;
          return deps.cyclesRepo.findActiveForMember(tenantId, memberId);
        },
      },
    };

    const baseArgs = {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorRole: 'admin' as const,
    };

    // #2 starts first: findById sees `open`, then parks at the gate.
    const p2 = acceptTierUpgrade(gatedDeps, {
      ...baseArgs,
      actorUserId: admin2.userId,
      correlationId: randomUUID(),
    });
    await reached;

    // #1 runs to FULL completion (commit included) while #2 is parked.
    const r1 = await acceptTierUpgrade(deps, {
      ...baseArgs,
      actorUserId: admin.userId,
      correlationId: randomUUID(),
    });
    expect(r1.ok).toBe(true);

    // Release #2 — it resumes carrying its stale `open` read.
    releaseGate();
    const r2 = await p2;

    // Exactly one accept wins — #2 MUST lose.
    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      // 065 S3 — UNLIKE the timing-dependent W-011 (which tolerates a
      // set of loser kinds because the loser may exit at different
      // seams), THIS probe is deterministic: #2's step-(a) succeeds and
      // its step-(c) CAS provably loses, throwing
      // `TierUpgradeStatusConflictError`, which `acceptTierUpgrade`'s
      // outer catch maps to EXACTLY `suggestion_not_open`. Pinning the
      // exact kind makes the test fail if the CAS ever throws an
      // UNMAPPED error that degrades to `server_error` (i.e. a
      // regression where the conflict no longer maps cleanly).
      expect(r2.error.kind).toBe('suggestion_not_open');
    }

    // `accepted_by_user_id` belongs to the winner (#1) — NOT
    // overwritten by the parked second accepter.
    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('accepted_pending_apply');
    expect(suggestion?.acceptedByUserId).toBe(admin.userId);

    // Exactly one `tier_upgrade_accepted` audit row for this
    // suggestion (the loser's tx rolled back before audit emit).
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

    // 065 S8 — atomic step-(a) money-safety pin. The PARTIAL UNIQUE
    // `scheduled_plan_changes_pending_uniq`
    // (`(tenant_id, member_id, effective_at_cycle_id) WHERE status =
    // 'pending'`) keeps at most ONE pending plan-change per (member,
    // cycle) — the member is never double-billed even when two accepts
    // race. Asserting exactly one pending row pins that index so a
    // future migration dropping it is caught here.
    //
    // S8 fix — accept step-(a) `supersedeAndInsertPendingAtomically`
    // now runs on the OUTER tx, so a CAS-losing accepter rolls BOTH its
    // F2 insert AND its F8 transition back atomically. The surviving
    // pending row therefore belongs to the WINNER (#1, admin.userId),
    // NOT the loser (#2, admin2.userId) — pre-fix, #2's step-(a)
    // committed in its own tx before the CAS fired and left an orphaned
    // loser-attributed row. The `scheduledByUserId` assertion catches a
    // regression of that atomicity.
    const pendingChanges = await runInTenant(tenant.ctx, (tx) =>
      (tx as unknown as typeof db)
        .select({
          id: scheduledPlanChanges.scheduledChangeId,
          scheduledByUserId: scheduledPlanChanges.scheduledByUserId,
        })
        .from(scheduledPlanChanges)
        .where(
          and(
            eq(scheduledPlanChanges.memberId, seeded.memberId),
            eq(scheduledPlanChanges.effectiveAtCycleId, seeded.cycleId),
            eq(scheduledPlanChanges.status, 'pending'),
          ),
        ),
    );
    expect(pendingChanges).toHaveLength(1);
    // The surviving pending row is the WINNER's (no orphaned loser row).
    expect(pendingChanges[0]?.scheduledByUserId).toBe(admin.userId);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 065 Fix B (S3 + S5) — genuine concurrent-at-step-(a) race
  //
  // W-011b parks accepter #2 BEFORE its tx (at the pre-tx
  // findActiveForMember), runs #1 to FULL COMMIT, THEN releases #2 — so
  // #2's step-(a) supersede cleanly supersedes #1's already-committed
  // pending row and #2 loses at the step-(c) CAS. It NEVER exercises the
  // genuine race where BOTH accepters are INSIDE their tx at step-(a)
  // before either commits — the race that raises a 23505 on the partial
  // unique `scheduled_plan_changes_pending_uniq` (S8 moved step-(a) onto
  // the outer tx, so the loser now hits the INSERT collision instead of
  // the CAS).
  //
  // This probe FORCES that race deterministically: accepter #1 is gated
  // to park INSIDE its tx, immediately AFTER its step-(a) supersede+insert
  // (holding the partial-unique lock on the fresh pending row) but BEFORE
  // its step-(c) CAS + commit. While #1 is parked, #2 runs — its step-(a)
  // INSERT BLOCKS on the unique-index lock #1 holds. Releasing #1 lets it
  // commit (CAS open→accepted_pending_apply wins, no concurrent commit yet
  // because #2 is blocked) → the lock releases → #2's blocked INSERT now
  // sees #1's committed pending row → 23505.
  //
  //   - Pre-Fix-B (step-(a) catch `return err plan_change_failed`): the
  //     23505 already POISONED the outer tx, so the `return err` is a lie
  //     — `runInTenant`'s COMMIT downgrades to ROLLBACK and the
  //     commit-of-aborted-tx THROWS, surfacing as `server_error` (500)
  //     from the OUTER catch (verified: observed
  //     `server_error: duplicate key ... "scheduled_plan_changes_pending_uniq"`).
  //     This is the S14 poisoned-tx trap directly. RED.
  //   - Post-Fix-B (23505 on the pending uniq → THROW
  //     TierUpgradeStatusConflictError → tx rolls back cleanly → outer
  //     catch maps to suggestion_not_open): #2 → suggestion_not_open
  //     (409). GREEN.
  //
  // Money-safety: exactly ONE pending row survives, attributed to the
  // WINNER (#1) — the loser's whole tx (its blocked-then-failed step-(a)
  // INSERT) rolls back.
  // ---------------------------------------------------------------------------
  it('W-011c genuine concurrent-at-step-a — INSERT collision maps loser to suggestion_not_open (409) + one winner pending row', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const admin2 = await createActiveTestUser('admin');
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Gate: accepter #1's step-(a) does the REAL supersede+insert on its
    // outer tx (holding the partial-unique lock on the new pending row),
    // signals it reached the seam, then PARKS — keeping its tx open so
    // #2's step-(a) INSERT blocks on the lock.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });

    const gatedDeps1: typeof deps = {
      ...deps,
      scheduledPlanChangeRepo: {
        ...deps.scheduledPlanChangeRepo,
        supersedeAndInsertPendingAtomically: async (t, input, tx) => {
          // Run the real INSERT on accepter #1's OUTER tx (065 S8 threads
          // it as the 3rd arg), then park with the tx still open.
          const result =
            await deps.scheduledPlanChangeRepo.supersedeAndInsertPendingAtomically(
              t,
              input,
              tx,
            );
          signalReached();
          await gate;
          return result;
        },
      },
    };

    // #2 is gated at its pre-tx `findActiveForMember` (runs right after
    // its `findById` `open` read) so we can PROVE #2 read `open` while #1
    // was still uncommitted — then we let #2 continue into its tx where
    // its step-(a) INSERT blocks on #1's lock. This pins the ordering
    // (#2 committed to the race BEFORE #1 commits), eliminating the
    // false-GREEN where #2's findById races AFTER #1's commit and exits
    // early via the pre-tx `suggestion_not_open` (which would pass on the
    // OLD code too, never exercising the 23505 INSERT collision).
    let release2!: () => void;
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    let signalReached2!: () => void;
    const reached2 = new Promise<void>((resolve) => {
      signalReached2 = resolve;
    });
    const gatedDeps2: typeof deps = {
      ...deps,
      cyclesRepo: {
        ...deps.cyclesRepo,
        findActiveForMember: async (tenantId: string, memberId: string) => {
          const snapshot = await deps.cyclesRepo.findActiveForMember(
            tenantId,
            memberId,
          );
          signalReached2();
          await gate2;
          return snapshot;
        },
      },
    };

    const baseArgs = {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorRole: 'admin' as const,
    };

    // #1 starts first: enters its tx, runs step-(a) INSERT, then parks
    // holding the unique-index lock.
    const p1 = acceptTierUpgrade(gatedDeps1, {
      ...baseArgs,
      actorUserId: admin.userId,
      correlationId: randomUUID(),
    });
    await reached;

    // #2 starts while #1 is parked: its pre-tx findById reads `open`
    // (#1 has NOT committed), then it parks at findActiveForMember.
    const p2 = acceptTierUpgrade(gatedDeps2, {
      ...baseArgs,
      actorUserId: admin2.userId,
      correlationId: randomUUID(),
    });
    // Wait until #2 has provably read `open` (its findById + the
    // findActiveForMember read both completed before #1 committed).
    await reached2;
    // Release #2 — it now enters its tx; its step-(a) INSERT blocks on the
    // partial-unique lock #1 holds.
    release2();
    // Give #2 a beat to reach + block on its blocked INSERT, then release
    // #1 so it commits → lock releases → #2's INSERT raises 23505.
    await new Promise((r) => setTimeout(r, 300));
    releaseGate();

    const [r1, r2] = await Promise.all([p1, p2]);

    // #1 (the parked winner) commits; #2 (blocked then 23505) loses.
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      // 065 Fix B — the INSERT-collision loser sees the SAME clean
      // conflict shape as a CAS loser: suggestion_not_open (409), NOT a
      // server-class plan_change_failed.
      expect(r2.error.kind).toBe('suggestion_not_open');
    }

    // Suggestion ends `accepted_pending_apply` attributed to #1.
    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('accepted_pending_apply');
    expect(suggestion?.acceptedByUserId).toBe(admin.userId);

    // Exactly ONE pending plan-change row survives, the WINNER's (#1) —
    // the loser's blocked-then-failed step-(a) INSERT rolled back.
    const pendingChanges = await runInTenant(tenant.ctx, (tx) =>
      (tx as unknown as typeof db)
        .select({
          id: scheduledPlanChanges.scheduledChangeId,
          scheduledByUserId: scheduledPlanChanges.scheduledByUserId,
        })
        .from(scheduledPlanChanges)
        .where(
          and(
            eq(scheduledPlanChanges.memberId, seeded.memberId),
            eq(scheduledPlanChanges.effectiveAtCycleId, seeded.cycleId),
            eq(scheduledPlanChanges.status, 'pending'),
          ),
        ),
    );
    expect(pendingChanges).toHaveLength(1);
    expect(pendingChanges[0]?.scheduledByUserId).toBe(admin.userId);

    // Exactly one `tier_upgrade_accepted` audit row for this suggestion
    // (the loser's tx rolled back before audit emit).
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

  // ---------------------------------------------------------------------------
  // 065 S7 — supersede set-membership CAS (stale-pinned-CAS regression)
  //
  // 065 added a CAS to `transitionStatus` and supersede threaded its
  // `findActiveForMember`-read status as `expectedFrom`. But that read
  // runs in its OWN tx (the port has no tx arg) — it is STALE by the
  // time the CAS UPDATE fires. A concurrent accept that commits
  // `open → accepted_pending_apply` in the read→update window makes the
  // pinned `expectedFrom: 'open'` CAS match 0 rows ⇒ supersede silently
  // no-ops (returns null) and the now-orphaned `accepted_pending_apply`
  // suggestion survives. It is NOT on a terminal cycle and (when the
  // admin's new plan == the upgrade target) NOT plan-diverged either, so
  // the W-002 reconcile backstop does NOT catch it → the upgrade
  // re-applies at renewal even though the admin reverted the plan
  // (money bug).
  //
  // Pre-065 supersede used an id-only WHERE — it cancelled the pending
  // upgrade from ANY active status. The correct CAS for supersede is a
  // SET-membership guard (`status IN ('open','accepted_pending_apply')`)
  // — both are valid FROM states for a manual override (use-case
  // docstring FR-039 step 5) — NOT a value-pinned guard.
  //
  // This probe FORCES the window deterministically: supersede's
  // `findActiveForMember` returns `open`, then parks; the concurrent
  // accept commits `open → accepted_pending_apply`; supersede resumes
  // carrying its stale `open` snapshot and runs the CAS.
  //
  //   - Pre-fix (`expectedFrom: fromStatus` = 'open'): CAS matches 0
  //     rows ⇒ silent no-op ⇒ suggestion STAYS `accepted_pending_apply`
  //     (RED — assertion below fails).
  //   - Post-fix (`expectedFromIn: ['open','accepted_pending_apply']`):
  //     CAS matches the now-`accepted_pending_apply` row ⇒ transitions
  //     to `superseded` (GREEN).
  // ---------------------------------------------------------------------------
  it('S7 stale-read race — concurrent accept then supersede MUST still supersede (set-membership CAS)', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Gate: supersede's tier-upgrade `findActiveForMember` does the real
    // read (sees `open`), signals it reached the seam, then parks until
    // released. The returned snapshot is therefore STALE by the time the
    // CAS UPDATE runs — exactly the TOCTOU window the fix must survive.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });

    const gatedDeps: typeof deps = {
      ...deps,
      tierUpgradeRepo: {
        ...deps.tierUpgradeRepo,
        findActiveForMember: async (tenantId: string, memberId: string) => {
          const snapshot = await deps.tierUpgradeRepo.findActiveForMember(
            tenantId,
            memberId,
          );
          signalReached();
          await gate;
          return snapshot;
        },
      },
    };

    // Supersede starts first: reads `open`, then parks at the gate.
    const supersedeP = supersedePendingTierUpgrade(gatedDeps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      manualChangeActorUserId: admin.userId,
      // Admin manually flips to the SAME plan the upgrade targets
      // ('premium') — the worst case: the W-002 plan-diverged backstop
      // would NOT catch the orphan (members.plan_id == to_plan_id), so
      // supersede is the only safety net.
      supersedingPlanId: 'premium',
      correlationId: randomUUID(),
    });
    await reached;

    // Concurrent accept runs to FULL completion (commit included),
    // moving the row `open → accepted_pending_apply` while supersede is
    // parked holding its stale `open` read.
    const accept = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(accept.ok).toBe(true);

    // Release supersede — it resumes carrying the stale `open` snapshot.
    releaseGate();
    const result = await supersedeP;
    expect(result.ok).toBe(true);

    // The manual override MUST win: the suggestion is `superseded`, NOT
    // an orphaned `accepted_pending_apply` that re-applies at renewal.
    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('superseded');
    expect(suggestion?.closedAt).not.toBeNull();

    // Exactly one supersede audit row landed (the manual override is
    // recorded once). The `superseded_from_status` label carries the
    // stale read ('open') by design — supersede keeps the captured
    // `fromStatus` for the audit label only; the row PRESENCE is what
    // proves the override committed.
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
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 065 S6 — F2 finaliser must be gated on the F8 apply result
  //
  // The F4 onPaid bridge runs F8 `applyPendingTierUpgradeInTx` (which
  // transitions the `accepted_pending_apply` suggestion → `applied` and
  // returns the applied suggestion-ids) THEN a post-tx F2 finaliser
  // (`finaliseF2ScheduledPlanChangeForCycle`) that flips the F2
  // `scheduled_plan_changes` pending row → applied and emits
  // `plan_change_applied`.
  //
  // ORIGINAL BUG: the finaliser fired whenever `resolvedCycleId !== null`
  // (set the moment a cycle was found, BEFORE the apply ran) — fully
  // DECOUPLED from whether F8 actually applied a suggestion. If a
  // supersede cancelled the F8 suggestion but the F2 pending row was
  // missed (the orphan state), F8 apply no-ops (returns []) yet the F2
  // finaliser still flips pending → applied + emits plan_change_applied
  // → BILLS a tier upgrade the supersede meant to cancel (money bug).
  //
  // 065 Fix A (supersedes the original S6 apply-count gate): the finaliser
  // is now gated on the F8 SUGGESTION STATUS — it is SKIPPED only when a
  // `superseded` suggestion targets the cycle (this orphan case). The
  // apply-count gate that the original S6 fix used broke webhook retry
  // self-heal (see the Fix-A S1 retry-heal test above); the status gate
  // closes BOTH the re-bill hole (here) AND the retry-strand hole.
  //
  // Orphan seed: accept (→ F8 accepted_pending_apply + F2 pending), then
  // directly flip the F8 suggestion to `superseded` in the DB WITHOUT
  // touching the F2 row — exactly the missed-supersede orphan the
  // S6 finding describes. Then fire the bridge for the cycle's invoice.
  // ---------------------------------------------------------------------------
  it('S6 orphan supersede — F2 finaliser MUST NOT flip pending→applied when the suggestion was superseded (cancelled upgrade)', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // 1) Accept → F8 accepted_pending_apply + F2 pending row.
    const accept = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(accept.ok).toBe(true);

    // 2) Orphan the F8 suggestion: flip it to `superseded` directly,
    //    leaving the F2 pending row UNTOUCHED (the supersede that missed
    //    the F2 row). The F8 apply will now no-op (no
    //    accepted_pending_apply row for the cycle).
    const fakeInvoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await (tx as unknown as typeof db)
        .update(tierUpgradeSuggestions)
        .set({ status: 'superseded', closedAt: sql`now()` })
        .where(
          eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId),
        );
      // Seed the draft invoice the cycle FK references, then link it
      // (renewal_cycles_linked_invoice_fk → invoices(invoice_id)).
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: fakeInvoiceId,
        memberId: seeded.memberId,
        planYear: 2026,
        planId: 'regular',
        draftByUserId: admin.userId,
        status: 'draft',
        currency: 'THB',
      });
      // Link the cycle to the invoice the bridge resolves by.
      await (tx as unknown as typeof db)
        .update(renewalCycles)
        .set({ linkedInvoiceId: fakeInvoiceId })
        .where(eq(renewalCycles.cycleId, seeded.cycleId));
    });

    // Sanity: F2 row IS pending pre-bridge (the orphan).
    const [beforeRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.memberId, seeded.memberId)),
    );
    expect(beforeRow?.status).toBe('pending');

    // 3) Fire the F4 onPaid bridge (callback[1] = tier-upgrade-apply)
    //    inside a real tenant tx with the linked invoice id.
    const evt: F4InvoicePaidEvent = {
      tenantId: tenant.ctx.slug,
      invoiceId: fakeInvoiceId,
      memberId: seeded.memberId,
      paidAt: new Date().toISOString(),
      amountSatang: asSatang(5_000_000n),
      vatSatang: asSatang(327_103n),
      currency: 'THB',
      paymentMethod: 'bank_transfer',
      triggeredBy: 'webhook',
    };
    // Invoke via the no-tx fallback path: the apply opens its OWN
    // runInTenant + commits before the post-tx F2 finaliser runs (the
    // production post-commit ordering). Wrapping in an outer
    // runInTenant would NEST the finaliser's own runInTenant and stall
    // on the pooled connection.
    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    await callbacks[1]!(evt, undefined);

    // 4) ASSERT: the F2 pending row must NOT have flipped to applied —
    //    the supersede cancelled the upgrade; billing it is the bug.
    const [afterRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.memberId, seeded.memberId)),
    );
    expect(afterRow?.status).toBe('pending');
    expect(afterRow?.appliedAt).toBeNull();

    // No plan_change_applied audit for this scheduled change.
    const appliedAudit = await runInTenant(tenant.ctx, (tx) =>
      (tx as unknown as typeof db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, 'plan_change_applied'),
            sql`${auditLog.payload}->>'scheduled_change_id' = ${beforeRow!.scheduledChangeId}`,
          ),
        ),
    );
    expect(appliedAudit).toHaveLength(0);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 065 S6 — positive regression: a normally accepted-then-paid upgrade
  // STILL applies BOTH the F8 suggestion AND the F2 plan-change.
  // ---------------------------------------------------------------------------
  it('S6 regression — accepted-then-paid upgrade applies BOTH F8 + F2 (no gate over-block)', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const accept = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(accept.ok).toBe(true);

    const fakeInvoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: fakeInvoiceId,
        memberId: seeded.memberId,
        planYear: 2026,
        planId: 'regular',
        draftByUserId: admin.userId,
        status: 'draft',
        currency: 'THB',
      });
      await (tx as unknown as typeof db)
        .update(renewalCycles)
        .set({ linkedInvoiceId: fakeInvoiceId })
        .where(eq(renewalCycles.cycleId, seeded.cycleId));
    });

    const evt: F4InvoicePaidEvent = {
      tenantId: tenant.ctx.slug,
      invoiceId: fakeInvoiceId,
      memberId: seeded.memberId,
      paidAt: new Date().toISOString(),
      amountSatang: asSatang(5_000_000n),
      vatSatang: asSatang(327_103n),
      currency: 'THB',
      paymentMethod: 'bank_transfer',
      triggeredBy: 'webhook',
    };
    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    await callbacks[1]!(evt, undefined);

    // F8 suggestion applied.
    const [suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(suggestion?.status).toBe('applied');

    // F2 plan-change applied.
    const [scheduled] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.memberId, seeded.memberId)),
    );
    expect(scheduled?.status).toBe('applied');
    expect(scheduled?.appliedAt).not.toBeNull();

    // plan_change_applied audit emitted for this scheduled change.
    const appliedAudit = await runInTenant(tenant.ctx, (tx) =>
      (tx as unknown as typeof db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, 'plan_change_applied'),
            sql`${auditLog.payload}->>'scheduled_change_id' = ${scheduled!.scheduledChangeId}`,
          ),
        ),
    );
    expect(appliedAudit).toHaveLength(1);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 065 Fix A (S1) — webhook retry self-heal of a stranded F2 row
  //
  // Stripe webhook delivery is at-least-once. On the FIRST delivery the
  // in-tx F8 apply commits the suggestion `accepted_pending_apply` →
  // `applied`, but the POST-tx F2 finaliser can fail transiently
  // (findPendingForCycle / transitionStatus `return`-non-rollback),
  // leaving the F2 `scheduled_plan_changes` row stuck `pending`. The
  // Stripe RE-delivery must heal it.
  //
  // The PRIOR S6 gate keyed the finaliser on THIS-run's apply count
  // (`appliedSuggestionCount > 0`): on the retry the apply finds the
  // suggestion ALREADY `applied`, returns [], the gate SKIPS the
  // finaliser → the F2 row is stranded `pending` FOREVER (RED on the old
  // gate). The Fix-A gate keys on suggestion-not-superseded instead — the
  // applied (NOT superseded) suggestion lets the finaliser run + heal the
  // stranded row.
  //
  // Strand seed (deterministic, no deps-injection needed): accept (→ F8
  // accepted_pending_apply + F2 pending), then flip the F8 suggestion to
  // `applied` directly in the DB while leaving the F2 row `pending` —
  // exactly the "first delivery applied F8 but its finaliser failed"
  // state. Then fire the bridge (the retry).
  // ---------------------------------------------------------------------------
  it('Fix A S1 retry-heal — F2 finaliser heals a stranded pending row even when F8 apply no-ops on the retry (suggestion already applied)', async () => {
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // 1) Accept → F8 accepted_pending_apply + F2 pending row.
    const accept = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(accept.ok).toBe(true);

    const fakeInvoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      // 2) Strand: flip the F8 suggestion to `applied` (the first
      //    delivery's apply committed), but DO NOT touch the F2 pending
      //    row (its post-tx finaliser failed). Set the applied anchors so
      //    the `applied` CHECK constraint passes + the disambiguation read
      //    is realistic.
      await (tx as unknown as typeof db)
        .update(tierUpgradeSuggestions)
        .set({
          status: 'applied',
          appliedAt: sql`now()`,
          appliedAtInvoiceId: fakeInvoiceId,
          closedAt: sql`now()`,
        })
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId));
      // Seed the draft invoice the cycle FK references, then link it.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: fakeInvoiceId,
        memberId: seeded.memberId,
        planYear: 2026,
        planId: 'regular',
        draftByUserId: admin.userId,
        status: 'draft',
        currency: 'THB',
      });
      await (tx as unknown as typeof db)
        .update(renewalCycles)
        .set({ linkedInvoiceId: fakeInvoiceId })
        .where(eq(renewalCycles.cycleId, seeded.cycleId));
    });

    // Sanity: the F2 row IS pending pre-retry (the strand), F8 IS applied.
    const [strandRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.memberId, seeded.memberId)),
    );
    expect(strandRow?.status).toBe('pending');
    const [strandSuggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(strandSuggestion?.status).toBe('applied');

    // 3) Fire the F4 onPaid bridge (retry). The apply finds the
    //    suggestion already `applied` → returns [] (no transition). The
    //    OLD count gate skipped here; the Fix-A gate finalises.
    const evt: F4InvoicePaidEvent = {
      tenantId: tenant.ctx.slug,
      invoiceId: fakeInvoiceId,
      memberId: seeded.memberId,
      paidAt: new Date().toISOString(),
      amountSatang: asSatang(5_000_000n),
      vatSatang: asSatang(327_103n),
      currency: 'THB',
      paymentMethod: 'bank_transfer',
      triggeredBy: 'webhook',
    };
    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    await callbacks[1]!(evt, undefined);

    // 4) ASSERT: the stranded F2 row is healed → applied.
    const [healedRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.memberId, seeded.memberId)),
    );
    expect(healedRow?.status).toBe('applied');
    expect(healedRow?.appliedAt).not.toBeNull();

    // plan_change_applied audit emitted for the healed change.
    const appliedAudit = await runInTenant(tenant.ctx, (tx) =>
      (tx as unknown as typeof db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, 'plan_change_applied'),
            sql`${auditLog.payload}->>'scheduled_change_id' = ${strandRow!.scheduledChangeId}`,
          ),
        ),
    );
    expect(appliedAudit).toHaveLength(1);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 065 Fix A precision (re-accept same cycle) — the cycle-wide gate is too
  // coarse
  //
  // A member can have TWO suggestions targeting the SAME active cycle when an
  // upgrade is accepted, manually overridden, then re-suggested + re-accepted:
  //
  //   1. suggestion1 accepted → F8 accepted_pending_apply + F2 pending row
  //      (reason `tier_upgrade_accepted:<S1>`).
  //   2. manual override (`supersedePendingTierUpgrade`) → suggestion1
  //      `superseded` (RETAINS target_apply_at_cycle_id; its F2 row is the
  //      orphan the prior S6 test covers). NOTE: the supersede listener only
  //      touches the F8 suggestion — it does NOT flip the F2 pending row.
  //   3. The partial-unique `tier_upgrade_suggestions_member_open_uniq`
  //      (status IN open, accepted_pending_apply) no longer covers the now-
  //      `superseded` suggestion1, so a FRESH suggestion2 can be inserted
  //      `open` for the same member + cycle.
  //   4. suggestion2 accepted → its `supersedeAndInsertPendingAtomically`
  //      supersedes the orphan F2 row (suggestion1's) and inserts a FRESH
  //      pending F2 row (reason `tier_upgrade_accepted:<S2>`), targeting the
  //      same active cycle. suggestion2 is now `accepted_pending_apply`.
  //   5. Renewal paid → bridge fires. F8 apply transitions suggestion2 →
  //      `applied`. The F2 finaliser SHOULD flip suggestion2's pending row.
  //
  // BUG (cycle-wide gate): `hasSupersededSuggestionForCycle(tenant, cycle)`
  // finds suggestion1 (`superseded`, target = cycle) → returns true → the
  // gate SKIPS the finaliser → suggestion2's VALID upgrade strands `pending`
  // forever (money-safe direction — strand, not over-bill — but wrong).
  //
  // FIX (per-pending-row gate): the finaliser gates on the pending F2 row's
  // OWN linked suggestion (`reason` → suggestion2 → `applied`, NOT
  // `superseded`) → finalise. RED on the cycle-wide gate; GREEN after.
  // ---------------------------------------------------------------------------
  it('Fix A re-accept precision — F2 finaliser flips suggestion2 pending→applied even when a SUPERSEDED suggestion1 also targets the cycle', async () => {
    // seedSuggestionState seeds member + cycle + suggestion1 (open).
    const seeded = await seedSuggestionState(tenant, admin, {
      daysUntilExpiry: 60,
      turnoverThb: 120_000_000,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // 1) Accept suggestion1 → F8 accepted_pending_apply + F2 pending row.
    const accept1 = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(accept1.ok).toBe(true);

    // 2) Manual override — supersedes suggestion1 (retains its cycle target).
    //    The supersede listener does NOT touch the F2 pending row; it is left
    //    as the orphan that step (4)'s accept will atomically supersede.
    const supersede = await supersedePendingTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      memberId: seeded.memberId,
      manualChangeActorUserId: admin.userId,
      supersedingPlanId: 'enterprise',
      correlationId: randomUUID(),
    });
    expect(supersede.ok).toBe(true);
    if (!supersede.ok) return;
    expect(supersede.value.supersededSuggestionId).toBe(seeded.suggestionId);

    // Sanity: suggestion1 is `superseded` AND still targets this cycle (so the
    // cycle-wide gate will match it). This is the coarse-gate trigger.
    const [s1Row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(s1Row?.status).toBe('superseded');
    expect(s1Row?.targetApplyAtCycleId).toBe(seeded.cycleId);

    // 3) Insert a FRESH open suggestion2 for the same member + cycle (now
    //    allowed — suggestion1 is terminal, so the member_open partial-unique
    //    no longer covers it).
    const suggestion2Uuid = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tierUpgradeSuggestions).values({
        tenantId: tenant.ctx.slug,
        suggestionId: suggestion2Uuid,
        memberId: seeded.memberId,
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
    const s2IdResult = parseSuggestionId(suggestion2Uuid);
    if (!s2IdResult.ok) throw new Error('suggestion2 id failed parse');
    const suggestion2Id = s2IdResult.value;

    // 4) Accept suggestion2 → supersedes the orphan F2 row + inserts a FRESH
    //    pending F2 row (reason `tier_upgrade_accepted:<S2>`) for the cycle.
    const accept2 = await acceptTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: suggestion2Id,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(accept2.ok).toBe(true);

    // The fresh pending F2 row is suggestion2's; capture its id for the audit
    // assertion. Exactly one pending row survives (partial-unique).
    const [s2Pending] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(
          and(
            eq(scheduledPlanChanges.memberId, seeded.memberId),
            eq(scheduledPlanChanges.effectiveAtCycleId, seeded.cycleId),
            eq(scheduledPlanChanges.status, 'pending'),
          ),
        ),
    );
    expect(s2Pending?.status).toBe('pending');
    expect(s2Pending?.reason).toBe(
      `tier_upgrade_accepted:${suggestion2Id}`,
    );

    // 5) Fire the F4 onPaid bridge for the cycle's invoice.
    const fakeInvoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: fakeInvoiceId,
        memberId: seeded.memberId,
        planYear: 2026,
        planId: 'regular',
        draftByUserId: admin.userId,
        status: 'draft',
        currency: 'THB',
      });
      await (tx as unknown as typeof db)
        .update(renewalCycles)
        .set({ linkedInvoiceId: fakeInvoiceId })
        .where(eq(renewalCycles.cycleId, seeded.cycleId));
    });

    const evt: F4InvoicePaidEvent = {
      tenantId: tenant.ctx.slug,
      invoiceId: fakeInvoiceId,
      memberId: seeded.memberId,
      paidAt: new Date().toISOString(),
      amountSatang: asSatang(5_000_000n),
      vatSatang: asSatang(327_103n),
      currency: 'THB',
      paymentMethod: 'bank_transfer',
      triggeredBy: 'webhook',
    };
    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    await callbacks[1]!(evt, undefined);

    // ASSERT: suggestion2's F2 pending row flipped to `applied` (its OWN
    // suggestion is `applied`, NOT superseded — the cycle-wide gate wrongly
    // skipped this because suggestion1 is superseded).
    const [s2After] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.scheduledChangeId, s2Pending!.scheduledChangeId)),
    );
    expect(s2After?.status).toBe('applied');
    expect(s2After?.appliedAt).not.toBeNull();

    // suggestion2 is `applied`.
    const [s2Suggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, suggestion2Id)),
    );
    expect(s2Suggestion?.status).toBe('applied');

    // plan_change_applied audit emitted for suggestion2's scheduled change.
    const appliedAudit = await runInTenant(tenant.ctx, (tx) =>
      (tx as unknown as typeof db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, 'plan_change_applied'),
            sql`${auditLog.payload}->>'scheduled_change_id' = ${s2Pending!.scheduledChangeId}`,
          ),
        ),
    );
    expect(appliedAudit).toHaveLength(1);
  }, 60_000);
});
