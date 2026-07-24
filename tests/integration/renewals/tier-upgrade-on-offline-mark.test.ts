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
 * WHAT THIS FILE DOES (070 Item D — WIRING LANDED)
 * ─────────────────────────────────────────────────────────────────────────
 * The Item-D fix wires the offline `onPaid` to mirror the online callback[1]:
 *   - in-tx: `applyPendingTierUpgradeInTx` transitions the pending suggestion
 *     `accepted_pending_apply` → `applied` (BEFORE create-next-cycle), and
 *   - post-tx: the offline use-case finalises the F2 `scheduled_plan_changes`
 *     row pending → applied + emits `plan_change_applied`.
 * The admin (offline actor) is the actor for both the F8 apply audit
 * (`tier_upgrade_applied_at_renewal`) and the F2 `plan_change_applied` audit —
 * an admin-initiated offline settlement, not a webhook (see the use-case +
 * apply-pending-tier-upgrade.ts actor decision).
 *
 *   1. An ACTIVE acceptance test that asserts the FIXED behaviour on live Neon:
 *      offline-mark applies the pending tier-upgrade (suggestion→applied, F2
 *      row→applied, both audits emitted) AND still completes the cycle + creates
 *      the next cycle.
 *
 * NOTE: this file asserts the SUGGESTION + F2 plan-change lifecycle only
 * (suggestion→applied, F2 row→applied, both audits). Package B1 now ALSO flips
 * `members.plan_id` in the apply so the next cycle follows the upgraded tier —
 * that plan-flip → next-cycle-billing reach is pinned separately by
 * tier-upgrade-reaches-billing.test.ts (both rails). This file does not
 * re-assert it.
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
      // Task 7 (rolling-anchor refactor) — a TERMINAL predecessor cycle so
      // this member has TWO cycles ever, not the shared classifier's
      // `first_payment` shape. This file pins the 070 Item-D tier-upgrade-
      // on-offline wiring (`prior?.status === 'completed'`) — without a
      // predecessor, the payment below would now re-anchor instead of
      // complete, breaking that assertion. 'cancelled' avoids needing a
      // second invoice FK target.
      // FIX-2 (PR #173 review, 2026-07-09) — `anchoredAt` set: a genuinely
      // cancelled-after-anchoring predecessor is SETTLED history; without
      // it the member no longer classifies as `renewal`.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'cancelled',
        periodFrom: new Date(now - 2 * 365 * MS_PER_DAY),
        periodTo: new Date(now - 365 * MS_PER_DAY),
        expiresAt: new Date(now - 365 * MS_PER_DAY),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date(now - 2 * 365 * MS_PER_DAY),
        closedAt: new Date(now - 365 * MS_PER_DAY),
        closedReason: 'cancelled',
      });
    });
    // tx2 — the awaiting_payment cycle in a STRICTLY LATER tx than the
    // cancelled predecessor above. `findLatestCycleForMember` orders by
    // `created_at DESC, cycle_id DESC`; both cycles inserted in ONE tx share
    // `created_at`, so the cancelled predecessor's random cycle_id could win
    // the tiebreaker and be picked as "latest" — tripping markPaidOffline's
    // terminated-gate (`member_terminated`) on ~50% of runs (a flaky failure).
    // Separate txs make the awaiting cycle deterministically latest. (Same fix
    // as tier-upgrade-reaches-billing.test.ts lines 108-114.)
    await runInTenant(tenant.ctx, async (tx) => {
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
        proRatePolicySnapshot: 'none',
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
              invoiceSubject: 'membership',
              paymentDate: input.paymentDate,
            });
          }
          return {
            ok: true,
            value: { invoiceId, paidAt, emailDispatch: 'sent' as const },
          };
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
  // ACCEPTANCE test (070 Item D) — the offline onPaid now mirrors the online
  // callback[1]: applies the pending tier-upgrade (suggestion→applied) in-tx
  // BEFORE creating the next cycle, then finalises the F2 scheduled-plan-
  // change (pending→applied) post-tx. Both apply audits land under the ADMIN
  // (offline) actor.
  // ───────────────────────────────────────────────────────────────────────
  it('offline mark-paid applies the pending tier-upgrade BEFORE creating the next cycle (suggestion→applied, F2→applied, both audits emitted)', async () => {
    const scenario = await seedAcceptedPendingUpgrade();

    // Sanity: post-accept, the suggestion is accepted_pending_apply + the F2
    // row is pending (the precondition the offline callback[1] now applies).
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

    // THE FIX: the tier-upgrade WAS applied — callback[1]-equivalent ran in-tx.
    // The suggestion is now `applied`, stamped with the paid invoice id
    // (mirrors the online apply-at-renewal contract).
    const [afterSuggestion] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, scenario.suggestionId)),
    );
    expect(afterSuggestion?.status).toBe('applied');
    expect(afterSuggestion?.appliedAtInvoiceId).toBe(scenario.invoiceId);

    // The F2 scheduled-plan-change flipped pending → applied (post-tx finalise).
    const [afterScheduled] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.memberId, scenario.memberId)),
    );
    expect(afterScheduled?.status).toBe('applied');

    // Both apply audits landed (F8 + F2).
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
    // The offline path is admin-driven — the F8 apply audit carries the admin
    // actor (NOT a webhook), since the admin initiated the offline settlement.
    expect(applyAudits[0]?.actorUserId).toBe(admin.userId);

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
    // The F2 plan-change-applied audit also carries the admin actor.
    expect(planChangeApplied[0]?.actorUserId).toBe(admin.userId);
  }, 90_000);
});
