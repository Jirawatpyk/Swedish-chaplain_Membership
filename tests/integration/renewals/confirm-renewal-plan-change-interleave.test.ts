/**
 * FINDING #20 (adversarial money-path review of Phase 2 #238) — confirm-renewal's
 * issue→link window desyncs `renewal_cycles.frozen_plan_*` from the linked §86/4.
 *
 * confirm-renewal runs in TWO transactions:
 *   Step-1  reads the cycle's frozen price + (optionally) plan-changes it, then
 *           COMMITS and RELEASES the `renewals:<tenant>:<cycle>` advisory lock;
 *   Step-3  issues the F4 §86/4 at the Step-1-captured (old) price, OUTSIDE any lock;
 *   Step-4  re-acquires the lock only to LINK the invoice.
 *
 * In the gap between Step-1's commit and Step-4's link, a concurrent admin
 * `change-plan` (immediate-refreeze) whose member-scoped issued-probe sees NO
 * committed invoice can CAS-refreeze the still-open, still-unlinked cycle to the
 * NEW price + record `member_plan_change_billing_effect(applied_to_open_cycle)`.
 * confirm then links its OLD-price invoice.
 *
 *   End state WITHOUT the fix: the cycle records the NEW plan/price but is linked
 *   to a §86/4 that BILLS the OLD price — the cycle-record + audit permanently
 *   disagree with the immutable tax document.
 *
 * ── The invariant this test pins ─────────────────────────────────────────────
 *   A renewal_cycle with `linked_invoice_id` set MUST have
 *   `parseThbDecimalToSatang(frozen_plan_price_thb)` EQUAL to the linked
 *   membership_fee line's `unit_price_satang`.
 *
 * The member already holds an issued §86/4 at the price they CONFIRMED (a §86/4 is
 * immutable), so the fix reconciles the CYCLE back to the billed snapshot at link
 * time — the plan change defers to the next cycle — rather than rebilling them.
 *
 * ── Test seam ────────────────────────────────────────────────────────────────
 * We drive the REAL `confirmRenewal` through a test F4 bridge whose
 * `issueInvoiceForRenewal` FIRST runs the REAL `changePlan` use-case (immediate-
 * refreeze flag ON) on the same member+cycle — this is the concurrent admin write
 * landing deterministically in the Step-1-commit → link window (confirm holds no
 * lock at Step-3) — and THEN delegates to the real F4 create+issue path. So the
 * §86/4 bills the Step-1 (old) price while the cycle has been refrozen to the new
 * price, reproducing the race with no timing flakiness.
 *
 * RED (pre-fix): the linked cycle's frozen price is the NEW 180,000 while its
 * §86/4 line bills the OLD 50,000 → the invariant assertion fails.
 * GREEN (post-fix): Step-4 reconciles the cycle's frozen fields back to the billed
 * 50,000 + emits a corrective `renewal_cycle_price_frozen`
 * (`reconciled_from_concurrent_plan_change: true`); the admin's plan change is
 * preserved on `members.plan_id` (defers to next cycle).
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
  confirmRenewal,
  makePlanChangeBillingRemediation,
  makeRenewalsDeps,
} from '@/modules/renewals';
import type { ConfirmRenewalDeps } from '@/modules/renewals/application/use-cases/confirm-renewal';
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
const NEW_FROZEN_THB = '180000.00';
const NEW_FROZEN_SATANG = 18_000_000n;

/**
 * The production `f4InvoicingForRenewalBridge` shape, with the F4 issue step's
 * PDF/Blob mocked (real createInvoiceDraft + issueInvoice run so the line math +
 * §86/4 numbering are exercised for real). `beforeIssue` runs ONCE, at the top of
 * the first issue call — i.e. AFTER confirm-renewal's Step-1 has committed (lock
 * released) and BEFORE the invoice is issued: the exact window Finding #20 races.
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

describe('FINDING #20 — confirm-renewal issue→link window vs concurrent change-plan refreeze', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let oldPlanId: string;
  let newPlanId: string;
  let memberId: string;
  let cycleId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({ tenant, vatRate: VAT_RATE });

    oldPlanId = `f20-old-${randomUUID().slice(0, 8)}`;
    newPlanId = `f20-new-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: oldPlanId,
        planName: { en: 'F20 Old' },
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
        planName: { en: 'F20 New' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: Number(NEW_FROZEN_SATANG),
        renewalTierBucket: 'premium',
      }),
    );

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Interleave Co',
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
        firstName: 'Inter',
        lastName: 'Leave',
        email: 'interleave@example.com',
        isPrimary: true,
      });
      // Anchored (renewal classification) cycle frozen at the OLD price,
      // awaiting_payment. The member does NOT change plan during confirm — the
      // concurrent admin does.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: oldPlanId,
        frozenPlanPriceThb: OLD_FROZEN_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2025-06-01T00:00:00Z'),
      });
    });
  }, 180_000);

  afterAll(async () => {
    for (const q of [
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)),
      db.delete(membershipPlans).where(eq(membershipPlans.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('reconciles the linked cycle back to the billed §86/4 price; no diverged cycle↔invoice pair', async () => {
    // The concurrent admin change-plan (immediate-refreeze ON) that lands in the
    // Step-1-commit → link window. It refreezes the open, unlinked cycle to the
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
        { actorUserId: user.userId, requestId: `f20-concurrent-cp-${cycleId}` },
        membersDeps,
      );
      if (!cp.ok) {
        throw new Error(`concurrent change-plan failed: ${JSON.stringify(cp.error)}`);
      }
      // Guard the test is meaningful: the concurrent write MUST have refrozen the
      // still-open, still-unlinked cycle (the divergence trigger). If this ever
      // deferred instead, the test would not exercise the race.
      expect(cp.value.billingEffect?.effect).toBe('applied_to_open_cycle');
    };

    const realDeps = makeRenewalsDeps(tenant.ctx.slug);
    const deps: ConfirmRenewalDeps = {
      tenant: realDeps.tenant,
      cyclesRepo: realDeps.cyclesRepo,
      auditEmitter: realDeps.auditEmitter,
      clock: realDeps.clock,
      planLookupForRenewal: realDeps.planLookupForRenewal,
      memberRenewalFlagsRepo: realDeps.memberRenewalFlagsRepo,
      memberPlanWriter: realDeps.memberPlanWriter,
      f4InvoicingBridge: makeInterleavingRenewalBridge(runConcurrentChangePlan),
    };

    const result = await confirmRenewal(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      // The member does NOT change plan — the admin does, concurrently.
      actorUserId: user.userId,
      actorRole: 'member',
      correlationId: `f20-confirm-${cycleId}`,
    });
    if (!result.ok) {
      throw new Error(`confirm failed: ${JSON.stringify(result.error)}`);
    }

    // ── The immutable tax document: bills the price the MEMBER CONFIRMED (old). ──
    const lineRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ kind: invoiceLines.kind, unitPriceSatang: invoiceLines.unitPriceSatang })
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, tenant.ctx.slug),
            eq(invoiceLines.invoiceId, result.value.invoiceId),
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
    expect(cycleRow[0]?.linkedInvoiceId).toBe(result.value.invoiceId);

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
    // Filter by the payload discriminator in JS (the drizzle `audit_event_type`
    // enum union is a curated subset that does not list every F8 event type —
    // the runtime pgEnum does; see the tuple-vs-DB drift note).
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
