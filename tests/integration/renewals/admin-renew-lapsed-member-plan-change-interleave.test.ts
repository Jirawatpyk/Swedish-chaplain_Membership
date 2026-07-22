/**
 * FIX H1 (follow-up to FINDING #20) — `adminRenewLapsedMember`'s issue→link
 * window desyncs `renewal_cycles.frozen_plan_*` from the linked §86/4, exactly
 * like confirm-renewal did before #20's reconcile-at-link fix.
 *
 * `adminRenewLapsedMember` runs in the same create→issue→link shape:
 *   Step-1 (tx1) creates a fresh `awaiting_payment` cycle frozen at the member's
 *          CURRENT plan price, then COMMITS (it holds NO advisory lock);
 *   Step-2  issues the F4 §86/4 at the Step-1-captured (old) price, OUTSIDE any lock;
 *   Step-3 (tx2) re-acquires the per-cycle advisory lock only to LINK the invoice.
 *
 * In the gap between Step-1's commit and Step-3's link, a concurrent admin
 * `change-plan` (immediate-refreeze ON) whose member-scoped issued-probe sees NO
 * committed invoice can CAS-refreeze the still-open, still-unlinked fresh cycle to
 * the NEW price + record `member_plan_change_billing_effect(applied_to_open_cycle)`.
 * admin-renew then links its OLD-price §86/4.
 *
 *   End state WITHOUT the fix: the cycle records the NEW plan/price but is linked
 *   to a §86/4 that BILLS the OLD price — the cycle-record + audit permanently
 *   disagree with the immutable tax document (the SAME divergence #20 closed for
 *   confirm-renewal, but through the admin lapsed-comeback door).
 *
 * ── The invariant this test pins ─────────────────────────────────────────────
 *   A renewal_cycle with `linked_invoice_id` set MUST have
 *   `parseThbDecimalToSatang(frozen_plan_price_thb)` EQUAL to the linked
 *   membership_fee line's `unit_price_satang`.
 *
 * The member already holds an issued §86/4 at the price the admin billed (a §86/4
 * is immutable), so the fix reconciles the CYCLE back to that billed snapshot at
 * link time — the plan change defers to the next cycle — rather than the member
 * being rebilled.
 *
 * ── Test seam ────────────────────────────────────────────────────────────────
 * We drive the REAL `adminRenewLapsedMember` through a test F4 bridge whose
 * `issueInvoiceForRenewal` FIRST runs the REAL `changePlan` use-case (immediate-
 * refreeze flag ON) on the same member — this is the concurrent admin write
 * landing deterministically in the Step-1-commit → link window (admin-renew holds
 * no lock at Step-2) — and THEN delegates to the real F4 create+issue path. So the
 * §86/4 bills the Step-1 (old) price while the fresh cycle has been refrozen to the
 * new price, reproducing the race with no timing flakiness. The SAME bridge shape
 * confirm-renewal-plan-change-interleave.test.ts uses.
 *
 * RED (pre-fix, plain `linkInvoice`): the linked cycle's frozen price is the NEW
 * 180,000 while its §86/4 line bills the OLD 50,000 → the invariant assertion +
 * the divergence scan fail.
 * GREEN (post-fix, `linkInvoiceAndReconcileFrozenPlanInTx`): Step-3 reconciles the
 * fresh cycle's frozen fields back to the billed 50,000 + emits a corrective
 * `renewal_cycle_price_frozen` (`reconciled_from_concurrent_plan_change: true`);
 * the admin's plan change is preserved on `members.plan_id` (defers to next cycle).
 *
 * Live Neon Singapore via .env.local.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang, parseThbDecimal, parseThbDecimalToSatang } from '@/lib/money';
import { changePlan, type MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  adminRenewLapsedMember,
  makePlanChangeBillingRemediation,
  makeRenewalsDeps,
} from '@/modules/renewals';
import type { AdminRenewLapsedMemberDeps } from '@/modules/renewals';
import type {
  F4InvoicingForRenewalBridge,
  IssueInvoiceForRenewalInput,
  IssueInvoiceForRenewalResult,
} from '@/modules/renewals/application/ports/f4-invoicing-bridge';
import {
  createInvoiceDraft,
  issueInvoice,
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
} from '@/modules/invoicing';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { checkPlanChangeDivergence } from '@/../scripts/check-plan-change-divergence';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const VAT_RATE = '0.0700';
const OLD_FROZEN_THB = '50000.00';
const OLD_FROZEN_SATANG = 5_000_000n;
/** The NEW plan the concurrent admin change-plan refreezes the fresh cycle to (180,000). */
const NEW_FROZEN_SATANG = 18_000_000n;

/**
 * The production `f4InvoicingForRenewalBridge` shape, with the F4 issue step's
 * PDF/Blob mocked (real createInvoiceDraft + issueInvoice run so the line math +
 * §86/4 numbering are exercised for real). `beforeIssue` runs ONCE, at the top of
 * the first issue call — i.e. AFTER admin-renew's Step-1 has committed the fresh
 * cycle and BEFORE the invoice is issued: the exact window FIX H1 races. Identical
 * to confirm-renewal-plan-change-interleave.test.ts's bridge.
 */
function makeInterleavingRenewalBridge(
  beforeIssue: () => Promise<void>,
): F4InvoicingForRenewalBridge {
  let fired = false;
  return {
    async issueInvoiceForRenewal(
      input: IssueInvoiceForRenewalInput,
    ): Promise<IssueInvoiceForRenewalResult> {
      if (!fired) {
        fired = true;
        await beforeIssue();
      }
      const frozenUnitPriceSatang = parseThbDecimalToSatang(input.frozenPlanPriceThb);
      const createResult = await createInvoiceDraft(makeCreateInvoiceDraftDeps(input.tenantId), {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        memberId: input.memberId,
        planId: input.planId,
        planYear: input.planYear,
        autoEmailOnIssue: input.autoEmailOnIssue,
        renewalSignal: { unitPriceSatang: frozenUnitPriceSatang },
        ...(input.membershipCoverage !== undefined
          ? { membershipCoverage: input.membershipCoverage }
          : {}),
      });
      if (!createResult.ok) {
        return {
          status: 'create_failed',
          errorCode: createResult.error.code,
          detail:
            'reason' in createResult.error
              ? String(createResult.error.reason)
              : createResult.error.code,
        };
      }
      const draft = createResult.value;
      const real = makeIssueInvoiceDeps(input.tenantId);
      const mockedIssueDeps: IssueInvoiceDeps = {
        ...real,
        pdfRender: {
          render: vi.fn(async (_i: PdfRenderInput) => ({
            bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
          })),
        },
        blob: {
          uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
            key,
            url: `https://blob.test/${key}`,
          })),
          uploadLogo: vi.fn(),
          signDownloadUrl: vi.fn(),
          downloadBytes: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        } as unknown as IssueInvoiceDeps['blob'],
      };
      const issueResult = await issueInvoice(mockedIssueDeps, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        invoiceId: draft.invoiceId,
      });
      if (!issueResult.ok) {
        return {
          status: 'issue_failed',
          errorCode: issueResult.error.code,
          detail:
            'reason' in issueResult.error
              ? String(issueResult.error.reason)
              : issueResult.error.code,
        };
      }
      const issued = issueResult.value;
      return {
        status: 'issued',
        invoiceId: issued.invoiceId,
        invoiceNumber: issued.documentNumber !== null ? String(issued.documentNumber) : '',
        totalSatang: issued.total !== null ? asSatang(BigInt(issued.total.satang)) : asSatang(0n),
      };
    },
  };
}

describe('FIX H1 — admin-renew-lapsed issue→link window vs concurrent change-plan refreeze', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let oldPlanId: string;
  let newPlanId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({ tenant, vatRate: VAT_RATE });

    oldPlanId = `h1-old-${randomUUID().slice(0, 8)}`;
    newPlanId = `h1-new-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: oldPlanId,
        planName: { en: 'H1 Old' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: Number(OLD_FROZEN_SATANG),
        renewalTierBucket: 'regular',
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: newPlanId,
        planName: { en: 'H1 New' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: Number(NEW_FROZEN_SATANG),
        renewalTierBucket: 'premium',
      }),
    );
  }, 180_000);

  afterAll(async () => {
    for (const q of [
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(membershipPlans).where(eq(membershipPlans.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  /**
   * Seed a lapsed member (member + primary contact, NO active cycle) plus a
   * SETTLED (anchored) terminal `lapsed` predecessor so the admin comeback
   * classifies `renewal` (real cycle history — not the zero-history
   * `first_payment` shape). The predecessor's gapless period (2020→2021 + 12mo)
   * is long expired, so the fresh cycle re-anchors to the current payment month.
   */
  async function seedLapsedMemberWithPredecessor(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `H1 Lapsed Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: oldPlanId,
        planYear: 2026,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'H1',
        lastName: 'Comeback',
        email: `h1-${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'lapsed',
        periodFrom: new Date('2020-01-01T00:00:00Z'),
        periodTo: new Date('2021-01-01T00:00:00Z'),
        expiresAt: new Date('2021-01-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: oldPlanId,
        frozenPlanPriceThb: OLD_FROZEN_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2020-01-01T00:00:00Z'),
        closedAt: new Date('2021-01-01T00:00:00Z'),
        closedReason: 'lapsed',
      });
    });
    return memberId;
  }

  it('reconciles the fresh cycle back to the billed §86/4 price; no diverged cycle↔invoice pair', async () => {
    const memberId = await seedLapsedMemberWithPredecessor();

    // The concurrent admin change-plan (immediate-refreeze ON) that lands in the
    // Step-1-commit → link window. It refreezes the fresh, unlinked cycle to the
    // NEW plan/price + records applied_to_open_cycle.
    const membersDeps = {
      ...buildMembersDeps(tenant.ctx),
      applyPlanChangeToBilling: makePlanChangeBillingRemediation(tenant.ctx.slug, {
        immediateRefreezeEnabled: true,
      }),
    };
    const runConcurrentChangePlan = async (): Promise<void> => {
      const cp = await changePlan(
        memberId as MemberId,
        { new_plan_id: newPlanId, new_plan_year: 2026 },
        { actorUserId: user.userId, requestId: `h1-concurrent-cp-${memberId}` },
        membersDeps,
      );
      if (!cp.ok) {
        throw new Error(`concurrent change-plan failed: ${JSON.stringify(cp.error)}`);
      }
      // Guard the test is meaningful: the concurrent write MUST have refrozen the
      // fresh, still-unlinked cycle (the divergence trigger). If this ever
      // deferred instead, the test would not exercise the race.
      expect(cp.value.billingEffect?.effect).toBe('applied_to_open_cycle');
    };

    const realDeps = makeRenewalsDeps(tenant.ctx.slug);
    const deps: AdminRenewLapsedMemberDeps = {
      tenant: realDeps.tenant,
      cyclesRepo: realDeps.cyclesRepo,
      auditEmitter: realDeps.auditEmitter,
      clock: realDeps.clock,
      planLookupForRenewal: realDeps.planLookupForRenewal,
      memberPlanLookup: realDeps.memberPlanLookup,
      cycleIdFactory: realDeps.cycleIdFactory,
      memberRenewalFlagsRepo: realDeps.memberRenewalFlagsRepo,
      f4InvoicingBridge: makeInterleavingRenewalBridge(runConcurrentChangePlan),
    };

    const result = await adminRenewLapsedMember(deps, {
      tenantId: tenant.ctx.slug,
      memberId,
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: `h1-admin-renew-${memberId}`,
      requestId: `h1-req-${memberId.slice(0, 8)}`,
    });
    if (!result.ok) {
      throw new Error(`admin renew failed: ${JSON.stringify(result.error)}`);
    }
    const { cycleId, invoiceId } = result.value;

    // ── The immutable tax document: bills the price the ADMIN billed (old). ──
    const lineRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ kind: invoiceLines.kind, unitPriceSatang: invoiceLines.unitPriceSatang })
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, tenant.ctx.slug),
            eq(invoiceLines.invoiceId, invoiceId),
          ),
        ),
    );
    const membershipLine = lineRows.find((l) => l.kind === 'membership_fee');
    expect(membershipLine).toBeDefined();
    expect(BigInt(membershipLine!.unitPriceSatang)).toBe(OLD_FROZEN_SATANG);

    // ── The cycle row + the LOAD-BEARING invariant. ──
    const cycleRow = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          frozen: renewalCycles.frozenPlanPriceThb,
          planId: renewalCycles.planIdAtCycleStart,
          tier: renewalCycles.tierAtCycleStart,
          linkedInvoiceId: renewalCycles.linkedInvoiceId,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(cycleRow[0]?.linkedInvoiceId).toBe(invoiceId);

    // INVARIANT: a linked cycle's frozen price === the linked §86/4 line unit price.
    expect(parseThbDecimalToSatang(parseThbDecimal(cycleRow[0]!.frozen))).toBe(
      BigInt(membershipLine!.unitPriceSatang),
    );
    // Concretely: reconciled back to the BILLED (old) plan/price, NOT the
    // concurrently-refrozen new one.
    expect(cycleRow[0]?.frozen).toBe(OLD_FROZEN_THB);
    expect(cycleRow[0]?.planId).toBe(oldPlanId);
    expect(cycleRow[0]?.tier).toBe('regular');

    // ── The admin's plan change is NOT lost — it defers to the next cycle. ──
    const memberRow = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ planId: members.planId })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1),
    );
    expect(memberRow[0]?.planId).toBe(newPlanId);

    // ── The correction is auditable: a truthful corrective price-frozen row. ──
    const tenantAuditRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType, payload: auditLog.payload })
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug)),
    );
    const corrective = tenantAuditRows.find(
      (r) =>
        (r.eventType as string) === 'renewal_cycle_price_frozen' &&
        (r.payload as { reconciled_from_concurrent_plan_change?: boolean } | null)
          ?.reconciled_from_concurrent_plan_change === true,
    );
    expect(corrective, 'a corrective renewal_cycle_price_frozen audit row').toBeDefined();
    expect((corrective!.payload as { frozen_price_thb?: string }).frozen_price_thb).toBe(
      OLD_FROZEN_THB,
    );

    // ── The standing divergence scan is CLEAN for this tenant. ──
    const report = await checkPlanChangeDivergence({ tenantId: tenant.ctx.slug });
    expect(report.divergences).toEqual([]);
  }, 180_000);
});
