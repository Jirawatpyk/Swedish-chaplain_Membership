/**
 * 070 Item D — tier-upgrade application on the OFFLINE mark-paid path
 * (live Neon integration).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GAP THIS FILE PINS
 * ─────────────────────────────────────────────────────────────────────────
 * When a renewal cycle is paid ONLINE (Stripe webhook → F4 `recordPayment`),
 * F4 fires the full `f8OnPaidCallbacks` array IN ORDER:
 *   [0] mark-cycle-complete  → flips the prior cycle →completed
 *   [1] apply-pending-tier-upgrade
 *          - in-tx : `applyPendingTierUpgradeInTx` transitions any
 *            `accepted_pending_apply` suggestion → `applied` + emits
 *            `tier_upgrade_applied_at_renewal`
 *          - post-tx: `finaliseF2ScheduledPlanChangeForCycle` flips the F2
 *            `scheduled_plan_changes` row pending → applied + emits
 *            `plan_change_applied`
 *   [2] create-next-cycle    → creates the gapless next cycle
 *
 * When an admin marks the SAME cycle paid OFFLINE
 * (`mark-paid-offline.ts`), the use-case builds its OWN single `onPaid`
 * callback (the F4 bridge wraps it as `[onPaid]`) that runs ONLY:
 *   - the completion flip (= callback[0] equivalent), and
 *   - `createNextCycleOnPaidInTx` (= callback[2] equivalent).
 * It does NOT run callback[1]. So on the offline path a member who had an
 * `accepted_pending_apply` tier-upgrade has it LEFT pending forever:
 *   - the F8 suggestion stays `accepted_pending_apply` (never `applied`),
 *   - the F2 `scheduled_plan_changes` row stays `pending` (never `applied`),
 *   - the `tier_upgrade_applied_at_renewal` + `plan_change_applied` audit
 *     events are never emitted for that paid renewal.
 *
 * This is a REACHABLE divergence (an admin can mark a renewal paid offline
 * for any member, including one with an accepted-pending upgrade) with
 * tier-upgrade-lifecycle + audit-trail implications. The fix is real WIRING
 * that touches the offline onPaid bridge ordering AND the F2 post-tx
 * finaliser (which must run AFTER the outer tx commits) — i.e. billing- and
 * tax-document-adjacent semantics. Per the 070 brief it is reported as
 * DONE_WITH_CONCERNS for a human / tax reviewer to weigh in, NOT silently
 * wired here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DOES
 * ─────────────────────────────────────────────────────────────────────────
 *   1. An ACTIVE characterization test that REPRODUCES the gap on live Neon
 *      (offline-mark leaves the suggestion `accepted_pending_apply` + the
 *      F2 row `pending`). It locks the current behaviour so the future fix
 *      provably changes it, and gives the reviewer runnable evidence.
 *   2. A `.skip`-ed acceptance test that pins the DESIRED end-state (the
 *      offline path applies the pending tier-upgrade BEFORE creating the
 *      next cycle, mirroring the online path). Un-skip + green it when the
 *      Item-D wiring lands. (`it.skip` in `tests/integration/` is permitted
 *      — `check:fixme` only blocks fixme/bare-skip in tests/e2e + contract.)
 *
 * NOTE: the next cycle inherits the prior cycle's `planIdAtCycleStart`
 * regardless of the tier-upgrade (apply does NOT flip the cycle's plan nor
 * `members.plan_id` — see `apply-pending-tier-upgrade.ts` docstring). So the
 * end-state pinned here is the SUGGESTION + F2 plan-change lifecycle, NOT a
 * "next cycle at upgraded tier" — the original brief's phrasing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { ok } from '@/lib/result';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import { scheduledPlanChanges } from '@/modules/plans/infrastructure/db/schema-scheduled-plan-changes';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  acceptTierUpgrade,
  markPaidOffline,
  makeRenewalsDeps,
} from '@/modules/renewals';
import type { RenewalGateway, RenewalsDeps } from '@/modules/renewals';
import {
  parseSuggestionId,
  type SuggestionId,
} from '@/modules/renewals/domain/tier-upgrade-suggestion';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Default-mock the live Resend gateway so each `acceptTierUpgrade` does not
// fire a real sandbox email (burns the shared test-key quota + adds latency).
// Mirrors the SUCCESS_GATEWAY pattern in tier-upgrade-pending.test.ts.
const SUCCESS_GATEWAY: Pick<RenewalGateway, 'sendTierUpgradeApprovalEmail'> = {
  sendTierUpgradeApprovalEmail: async () =>
    ok({
      deliveryId: 'test-mock-delivery',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
    }),
};

function makeAcceptDeps(slug: string): RenewalsDeps {
  const base = makeRenewalsDeps(slug);
  return {
    ...base,
    renewalGateway: { ...base.renewalGateway, ...SUCCESS_GATEWAY },
  };
}

interface SeededUpgradeScenario {
  readonly memberId: string;
  readonly cycleId: string;
  readonly suggestionId: SuggestionId;
  readonly invoiceId: string;
}

describe('F8 tier-upgrade on OFFLINE mark-paid — 070 Item D (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  /**
   * Seed: member + an `awaiting_payment` renewal cycle (anchored to the real
   * `regular` plan so the next-cycle plan-lookup resolves a frozen price) +
   * an `open` tier-upgrade suggestion. Then `acceptTierUpgrade` to land the
   * suggestion in `accepted_pending_apply` + a `pending` F2 scheduled-plan-
   * change. Also seed an issued F4 invoice the offline-mark bridge mock fires
   * `onPaid` against (the cycle→invoice FK target + the linked-invoice the
   * next-cycle creation resolves the prior cycle by).
   */
  async function seedAcceptedPendingUpgrade(): Promise<SeededUpgradeScenario> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const suggestionUuid = randomUUID();
    const invoiceId = randomUUID();
    const now = Date.now();
    const expiresAt = new Date(now + 60 * MS_PER_DAY);

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Offline Upgrade Co',
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
        turnoverThb: 120_000_000,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Offline',
        lastName: 'Upgrade',
        email: `offline-up-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
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
      // Issued F4 invoice — FK target for the completion flip + the linked-
      // invoice lookup createNextCycleOnPaidInTx uses to resolve the prior.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'regular',
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: admin.userId,
        fiscalYear: 2026,
        sequenceNumber: 9001,
        documentNumber: 'INV-2026-009001',
        issueDate: '2026-05-15',
        dueDate: '2026-06-14',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'whole_year',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Offline Upgrade Co',
          country: 'TH',
          legal_name: 'Offline Upgrade Co Ltd',
          address: '1 Offline Road, Bangkok 10110',
          primary_contact_name: 'Offline Upgrade',
          primary_contact_email: 'offline-up@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'c'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });

    // Accept → accepted_pending_apply + a pending F2 scheduled-plan-change.
    const idResult = parseSuggestionId(suggestionUuid);
    if (!idResult.ok) throw new Error('seeded suggestion id failed parse');
    const suggestionId = idResult.value;

    const acceptResult = await acceptTierUpgrade(makeAcceptDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(acceptResult.ok).toBe(true);

    return { memberId, cycleId, suggestionId, invoiceId };
  }

  /**
   * Mock the F4 bridge so `markPaidOffline` runs its in-tx `onPaid` against
   * the seeded issued invoice (flips the cycle →completed + runs the offline
   * onPaid chain) — exactly the pattern in mark-paid-offline.test.ts.
   */
  function mockBridgeFireOnPaid(
    deps: RenewalsDeps,
    invoiceId: string,
  ): RenewalsDeps {
    const paidAt = new Date().toISOString();
    return {
      ...deps,
      f4InvoiceBridge: {
        ...deps.f4InvoiceBridge,
        issueAndMarkPaid: async (input) => {
          if (input.onPaid) {
            await input.onPaid({
              tenantId: input.tenantId,
              invoiceId,
              memberId: input.memberId,
              paidAt,
              amountSatang: asSatang(5_000_000n),
              vatSatang: asSatang(350_000n),
              currency: 'THB',
              paymentMethod: input.paymentMethod,
              triggeredBy: 'admin_offline_mark',
            });
          }
          return { ok: true, value: { invoiceId, paidAt } };
        },
      },
    };
  }

  async function markScenarioPaidOffline(
    scenario: SeededUpgradeScenario,
  ): Promise<void> {
    const deps = mockBridgeFireOnPaid(
      makeRenewalsDeps(tenant.ctx.slug),
      scenario.invoiceId,
    );
    const r = await markPaidOffline(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: scenario.cycleId,
      paymentMethod: 'bank_transfer',
      paymentReference: 'BT-OFFLINE-UPGRADE',
      paymentDate: '2026-05-15',
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // `regular` (from) + `premium` (to) plans for the upgrade.
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: 'regular',
        planName: { en: 'Regular' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
        minTurnoverMinorUnits: 50_000_000,
        renewalTierBucket: 'regular',
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: 'premium',
        planName: { en: 'Premium' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
        minTurnoverMinorUnits: 100_000_000,
        renewalTierBucket: 'premium',
      }),
    );
  }, 180_000);

  afterAll(async () => {
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
      // invoices AFTER renewal_cycles (cycle→invoice FK), BEFORE members.
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
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    // Clear per-test rows but keep the plan catalogue.
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
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
    ]) {
      await tableQuery.catch(() => {});
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // ACTIVE characterization test — REPRODUCES the gap on live Neon.
  // ───────────────────────────────────────────────────────────────────────
  it('CURRENT BEHAVIOUR (gap pinned): offline mark-paid completes the cycle + creates the next cycle but does NOT apply the pending tier-upgrade', async () => {
    const scenario = await seedAcceptedPendingUpgrade();

    // Sanity: post-accept, the suggestion is accepted_pending_apply + the F2
    // row is pending (the precondition the online callback[1] would apply).
    const [beforeSuggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, scenario.suggestionId)),
    );
    expect(beforeSuggestion?.status).toBe('accepted_pending_apply');
    const [beforeScheduled] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.memberId, scenario.memberId)),
    );
    expect(beforeScheduled?.status).toBe('pending');

    await markScenarioPaidOffline(scenario);

    // The cycle DID complete + a next cycle WAS created (the offline path
    // runs callback[0]-equivalent + callback[2]-equivalent).
    const cycles = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, scenario.memberId)),
    );
    const prior = cycles.find((c) => c.cycleId === scenario.cycleId);
    expect(prior?.status).toBe('completed');
    expect(prior?.closedReason).toBe('completed_offline');
    const next = cycles.find(
      (c) => c.cycleId !== scenario.cycleId && c.status === 'upcoming',
    );
    expect(next).toBeDefined();

    // THE GAP: the tier-upgrade was NOT applied — callback[1] never ran.
    // The suggestion is STILL accepted_pending_apply (not `applied`).
    const [afterSuggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, scenario.suggestionId)),
    );
    expect(afterSuggestion?.status).toBe('accepted_pending_apply');
    expect(afterSuggestion?.appliedAtInvoiceId).toBeNull();

    // The F2 scheduled-plan-change is STILL pending (not `applied`).
    const [afterScheduled] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.memberId, scenario.memberId)),
    );
    expect(afterScheduled?.status).toBe('pending');

    // Neither the F8 apply audit nor the F2 plan-change-applied audit landed.
    const applyAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(
            auditLog.eventType,
            'tier_upgrade_applied_at_renewal' as never,
          ),
        ),
      );
    expect(applyAudits).toHaveLength(0);
    const planChangeApplied = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'plan_change_applied' as never),
        ),
      );
    expect(planChangeApplied).toHaveLength(0);
  }, 90_000);

  // ───────────────────────────────────────────────────────────────────────
  // SKIPPED acceptance test — the DESIRED end-state once the Item-D wiring
  // lands. Un-skip + green it when the offline onPaid bridge applies the
  // pending tier-upgrade (callback[1]) BEFORE creating the next cycle.
  //
  // BLOCKED on the Item-D wiring decision (DONE_WITH_CONCERNS): wiring the
  // offline onPaid to apply the pending upgrade touches billing/tax-document-
  // adjacent semantics (tier upgrades change what a member is billed) AND the
  // F2 post-tx finaliser, so it is deferred for human/tax review rather than
  // shipped blind. `it.skip` in tests/integration/ is allowed (check:fixme
  // only blocks fixme/bare-skip in tests/e2e + tests/contract).
  // ───────────────────────────────────────────────────────────────────────
  it.skip('DESIRED (Item-D wiring): offline mark-paid applies the pending tier-upgrade BEFORE creating the next cycle (suggestion→applied, F2→applied, audits emitted)', async () => {
    const scenario = await seedAcceptedPendingUpgrade();

    await markScenarioPaidOffline(scenario);

    // Suggestion transitioned accepted_pending_apply → applied, stamped with
    // the paid invoice id (mirrors the online apply-at-renewal contract).
    const [afterSuggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, scenario.suggestionId)),
    );
    expect(afterSuggestion?.status).toBe('applied');
    expect(afterSuggestion?.appliedAtInvoiceId).toBe(scenario.invoiceId);

    // F2 scheduled-plan-change flipped pending → applied.
    const [afterScheduled] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.memberId, scenario.memberId)),
    );
    expect(afterScheduled?.status).toBe('applied');

    // Both apply audits landed.
    const applyAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(
            auditLog.eventType,
            'tier_upgrade_applied_at_renewal' as never,
          ),
        ),
      );
    expect(applyAudits.length).toBeGreaterThanOrEqual(1);
    const planChangeApplied = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'plan_change_applied' as never),
        ),
      );
    expect(planChangeApplied.length).toBeGreaterThanOrEqual(1);

    // The cycle still completed + the next cycle was still created.
    const cycles = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, scenario.memberId)),
    );
    expect(
      cycles.find((c) => c.cycleId === scenario.cycleId)?.status,
    ).toBe('completed');
    expect(
      cycles.some(
        (c) => c.cycleId !== scenario.cycleId && c.status === 'upcoming',
      ),
    ).toBe(true);
  }, 90_000);
});
