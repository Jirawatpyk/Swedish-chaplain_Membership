/**
 * Plan-change -> billing remediation (Package B1) — the TIER-UPGRADE rail's
 * billing-reach regression net. Live Neon Singapore via .env.local.
 *
 * THE BUG (sibling of the manual-changePlan bug Package A pinned): an
 * accepted tier-upgrade suggestion transitions to `applied` at renewal but
 * writes NO plan column anywhere — not the cycle, not `members.plan_id`. So
 * after Package A rewired the next-cycle seed to read `members.plan_id`, an
 * accepted upgrade's NEXT cycle is STILL seeded from the OLD plan: the member
 * pays for the upgrade, the suggestion says `applied`, but they keep being
 * billed the old tier forever.
 *
 * THE FIX (this file pins it at BOTH payment rails): `applyPendingTierUpgrade
 * InTx` flips `members.plan_id` (+ `plan_year`) to the suggestion's target
 * plan, ATOMICALLY in the F4-paid tx, AFTER the CAS transition succeeds — so
 * Package A's seed (which runs later in the SAME tx) picks the new plan up.
 *   - ONLINE  — the F4 record-payment webhook rail (`f8OnPaidCallbacks`
 *     chain: [0] complete → [1] apply-tier-upgrade → [2] create-next-cycle).
 *   - OFFLINE — the admin `markPaidOffline` rail (070 Item D wired the same
 *     ordering into its single `onPaid`).
 *
 * SECOND CASE (the S6 money-safety gate): a tier-upgrade whose suggestion is
 * SUPERSEDED before payment must NOT drive a plan flip — the CAS
 * (`expectedFrom: 'accepted_pending_apply'`) + findPendingForCycle's partial
 * index on that status are the gate. `members.plan_id` stays on the old plan
 * and the next cycle stays on the old plan.
 *
 * SEED NOTE: the suggestion is inserted DIRECTLY in `accepted_pending_apply`
 * (satisfying the migration-0091 accepted CHECK) rather than driven through
 * `acceptTierUpgrade`. That deliberately omits the F2 `scheduled_plan_changes`
 * row acceptTierUpgrade would create, so the online chain's post-tx F2
 * finaliser short-circuits (`findPendingForCycle` → null). Threading that
 * finaliser through the SAME wrapping tx the callbacks run in would emit a
 * SECOND member-scoped audit whose `last_activity_at` trigger deadlocks
 * against the outer tx's member-row lock — a latent condition orthogonal to
 * the plan-flip this file pins. The apply's members.plan_id flip is what
 * matters here; the F2 finalise lifecycle is covered by
 * tier-upgrade-on-offline-mark.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  markPaidOffline,
  makeRenewalsDeps,
  f8OnPaidCallbacks,
} from '@/modules/renewals';
import type { RenewalsDeps } from '@/modules/renewals';
import { asSuggestionId, type SuggestionId } from '@/modules/renewals/domain/tier-upgrade-suggestion';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// Plan 'regular' (the member's start plan) vs 'premium' (the upgrade target).
// Distinct price so the next-cycle frozen price proves the divergence.
const REGULAR_FEE_MINOR = 5_000_000; // 50,000.00 THB
const PREMIUM_FEE_MINOR = 9_000_000; // 90,000.00 THB
const PREMIUM_PRICE_THB = '90000.00';

// Prior awaiting_payment cycle: fiscal-2026 period (Jan-start tenant). Premium
// has a 2026 catalogue row so BOTH the tier-upgrade apply's exact-year OFFER
// lookup (year 2026) AND the next-cycle FREEZE seed resolve it.
const PRIOR_PERIOD_FROM = new Date('2026-06-01T00:00:00.000Z');
const PRIOR_PERIOD_TO = new Date('2027-06-01T00:00:00.000Z');

interface UpgradeScenario {
  readonly memberId: string;
  readonly cycleId: string;
  readonly suggestionId: SuggestionId;
  readonly invoiceId: string;
}

interface NextCycle {
  readonly planId: string;
  readonly frozenPrice: string;
  readonly tier: string;
}

describe('tier-upgrade reaches billing — ONLINE + OFFLINE rails (Package B1)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  /**
   * Seed a member on 'regular' with a terminal predecessor (so the paying
   * cycle classifies as `renewal`), an awaiting_payment cycle on 'regular'
   * linked to a seeded issued invoice, and a regular→premium suggestion in
   * `accepted_pending_apply` (direct insert; anchors satisfy the 0091
   * accepted CHECK; no F2 scheduled_plan_changes row — see file header).
   */
  async function seedAcceptedUpgrade(): Promise<UpgradeScenario> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const suggestionUuid = randomUUID();
    const invoiceId = randomUUID();

    // tx1 — member, contact, terminal predecessor, invoice. The predecessor
    // MUST land in an EARLIER tx than the awaiting cycle (tx2): both cycles'
    // `created_at` default to the tx timestamp and `findLatestCycleForMember`
    // orders by `created_at DESC, cycle_id DESC`. Same-tx inserts share
    // created_at, so the random cycle_id tiebreaker could pick the (cancelled)
    // predecessor as "latest" → markPaidOffline's terminated-gate would refuse
    // with `member_terminated`. Separate txs make the awaiting cycle latest.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Upgrade Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
        turnoverThb: 120_000_000,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Tier',
        lastName: 'Upgrade',
        email: `tu-${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      // Terminal predecessor (settled history) so the paying cycle classifies
      // as `renewal` -> completes + creates a next cycle (NOT first_payment).
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'cancelled',
        periodFrom: new Date('2024-01-01T00:00:00.000Z'),
        periodTo: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: new Date('2025-01-01T00:00:00.000Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2024-01-01T00:00:00.000Z'),
        closedAt: new Date('2025-01-01T00:00:00.000Z'),
        closedReason: 'cancelled',
      });
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
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
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
          companyName: 'Upgrade Co',
          country: 'TH',
          legal_name: 'Upgrade Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Tier Upgrade',
          primary_contact_email: 'tu@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });
    // tx2 — the awaiting_payment cycle (strictly later created_at than the
    // predecessor) + the suggestion targeting it.
    await runInTenant(tenant.ctx, async (tx) => {
      // Awaiting_payment cycle on 'regular', linked to the issued invoice.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: PRIOR_PERIOD_FROM,
        periodTo: PRIOR_PERIOD_TO,
        expiresAt: PRIOR_PERIOD_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        linkedInvoiceId: invoiceId,
      });
      // Suggestion in accepted_pending_apply targeting the cycle.
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
        status: 'accepted_pending_apply',
        acceptedAt: new Date(),
        acceptedByUserId: admin.userId,
        targetApplyAtCycleId: cycleId,
      });
    });

    return {
      memberId,
      cycleId,
      suggestionId: asSuggestionId(suggestionUuid),
      invoiceId,
    };
  }

  async function loadMemberPlan(memberId: string): Promise<{
    planId: string;
    planYear: number;
  }> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ planId: members.planId, planYear: members.planYear })
        .from(members)
        .where(eq(members.memberId, memberId)),
    );
    return { planId: rows[0]!.planId, planYear: rows[0]!.planYear };
  }

  async function loadNextCycle(
    memberId: string,
    priorCycleId: string,
  ): Promise<NextCycle> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          cycleId: renewalCycles.cycleId,
          status: renewalCycles.status,
          planId: renewalCycles.planIdAtCycleStart,
          frozenPrice: renewalCycles.frozenPlanPriceThb,
          tier: renewalCycles.tierAtCycleStart,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );
    const next = rows.find(
      (r) => r.cycleId !== priorCycleId && r.status === 'upcoming',
    );
    expect(next, 'a NEW upcoming next cycle must exist after payment').toBeDefined();
    return { planId: next!.planId, frozenPrice: next!.frozenPrice, tier: next!.tier };
  }

  function buildPaidEvent(scenario: UpgradeScenario): F4InvoicePaidEvent {
    return {
      tenantId: tenant.ctx.slug,
      invoiceId: scenario.invoiceId,
      memberId: scenario.memberId,
      paidAt: new Date('2026-06-05T09:00:00.000Z').toISOString(),
      amountSatang: asSatang(5_350_000n),
      vatSatang: asSatang(350_000n),
      currency: 'THB',
      paymentMethod: 'stripe_card',
      triggeredBy: 'webhook',
      invoiceSubject: 'membership',
      paymentDate: null,
    };
  }

  /** OFFLINE rail: mock the F4 bridge to fire onPaid against the seeded invoice. */
  function mockBridgeFireOnPaid(deps: RenewalsDeps, invoiceId: string): RenewalsDeps {
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
          return { ok: true, value: { invoiceId, paidAt, emailDispatch: 'sent' as const } };
        },
      },
    };
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: 'regular',
        planName: { en: 'Regular' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
        annualFeeMinorUnits: REGULAR_FEE_MINOR,
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
        annualFeeMinorUnits: PREMIUM_FEE_MINOR,
        minTurnoverMinorUnits: 100_000_000,
        renewalTierBucket: 'premium',
      }),
    );
  }, 180_000);

  afterAll(async () => {
    for (const q of [
      db.delete(tierUpgradeSuggestions).where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)),
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(membershipPlans).where(eq(membershipPlans.tenantId, tenant.ctx.slug)),
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    for (const q of [
      db.delete(tierUpgradeSuggestions).where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)),
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
  });

  it('ONLINE rail: accepted tier-upgrade flips members.plan_id AND the next cycle to premium', async () => {
    const scenario = await seedAcceptedUpgrade();

    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    await runInTenant(tenant.ctx, async (tx) => {
      const evt = buildPaidEvent(scenario);
      for (const cb of callbacks) {
        await cb(evt, tx);
      }
    });

    const member = await loadMemberPlan(scenario.memberId);
    expect(member.planId, 'members.plan_id after apply').toBe('premium');
    expect(member.planYear, 'members.plan_year after apply').toBe(2026);

    const next = await loadNextCycle(scenario.memberId, scenario.cycleId);
    expect(next.planId, 'next cycle planId').toBe('premium');
    expect(next.frozenPrice, 'next cycle frozen price').toBe(PREMIUM_PRICE_THB);
    expect(next.tier, 'next cycle tier').toBe('premium');
  }, 120_000);

  it('OFFLINE rail: accepted tier-upgrade flips members.plan_id AND the next cycle to premium', async () => {
    const scenario = await seedAcceptedUpgrade();

    const deps = mockBridgeFireOnPaid(makeRenewalsDeps(tenant.ctx.slug), scenario.invoiceId);
    const r = await markPaidOffline(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: scenario.cycleId,
      paymentMethod: 'bank_transfer',
      paymentReference: `BT-${scenario.memberId.slice(0, 8)}`,
      paymentDate: '2026-06-05',
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok, `markPaidOffline: ${JSON.stringify(r.ok ? null : r.error)}`).toBe(true);

    const member = await loadMemberPlan(scenario.memberId);
    expect(member.planId, 'members.plan_id after apply').toBe('premium');
    expect(member.planYear, 'members.plan_year after apply').toBe(2026);

    const next = await loadNextCycle(scenario.memberId, scenario.cycleId);
    expect(next.planId, 'next cycle planId').toBe('premium');
    expect(next.frozenPrice, 'next cycle frozen price').toBe(PREMIUM_PRICE_THB);
    expect(next.tier, 'next cycle tier').toBe('premium');
  }, 120_000);

  it('S6 money-safety: a SUPERSEDED upgrade never flips members.plan_id (stays on regular)', async () => {
    const scenario = await seedAcceptedUpgrade();

    // Supersede the accepted suggestion BEFORE payment (the manual-override
    // orphan the S6 gate protects). findPendingForCycle's partial index (on
    // status='accepted_pending_apply') no longer returns it, and the apply's
    // CAS would reject it anyway — so a superseded suggestion never reaches
    // the plan flip.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(tierUpgradeSuggestions)
        .set({ status: 'superseded', closedAt: new Date() })
        .where(eq(tierUpgradeSuggestions.suggestionId, scenario.suggestionId)),
    );
    // Sanity: the supersede actually landed (guards the S6 precondition).
    const [superseded] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: tierUpgradeSuggestions.status })
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, scenario.suggestionId)),
    );
    expect(superseded?.status, 'suggestion must be superseded before payment').toBe('superseded');

    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    await runInTenant(tenant.ctx, async (tx) => {
      const evt = buildPaidEvent(scenario);
      for (const cb of callbacks) {
        await cb(evt, tx);
      }
    });

    const member = await loadMemberPlan(scenario.memberId);
    expect(member.planId, 'members.plan_id must NOT flip on a superseded upgrade').toBe('regular');
    expect(member.planYear).toBe(2026);

    const next = await loadNextCycle(scenario.memberId, scenario.cycleId);
    expect(next.planId, 'next cycle stays on regular').toBe('regular');

    // The suggestion was NOT applied — it stays terminal-`superseded` (the
    // apply's CAS never touched it). This member-scoped check is immune to
    // cross-test audit_log residue (the global-db cleanup no-ops under RLS).
    const [after] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: tierUpgradeSuggestions.status })
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, scenario.suggestionId)),
    );
    expect(after?.status, 'a superseded upgrade must never become applied').toBe('superseded');
  }, 120_000);
});
