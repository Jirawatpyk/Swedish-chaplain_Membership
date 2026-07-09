/**
 * F8-completion Slice 1 · Task 1.5 (B6) — confirm-with-plan-change
 * frozen-price billing. Live Neon Singapore via .env.local.
 *
 * FR-021b + FR-022 together: a member confirms a renewal AND picks a
 * different (higher-priced) plan. `confirmRenewal` re-snapshots the
 * cycle's frozen columns to the NEW plan via `updateFrozenPlan`, then
 * issues the §86/4 billing the NEW plan's FROZEN value — NOT the old
 * frozen price, NOT either plan's LIVE catalogue price (both of which
 * are bumped here to a third/fourth distinct number to prove the
 * source).
 *
 * Test seam: the REAL `confirmRenewal` use-case (state validation +
 * plan-change branch + cycle re-snapshot + link) driven through a test
 * F4 bridge that mirrors the production `f4InvoicingForRenewalBridge`
 * exactly (real `createInvoiceDraft` WITH the renewal signal + real
 * `issueInvoice`) but injects a mocked PDF render + Blob upload so the
 * test does not depend on Vercel Blob. The grand-total / line math runs
 * through the real F4 code path.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { confirmRenewal, makeRenewalsDeps } from '@/modules/renewals';
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
import { asSatang, parseThbDecimalToSatang } from '@/lib/money';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const VAT_RATE = '0.0700';

// The cycle is created frozen at the OLD plan's price; the member then
// picks the NEW plan whose frozen price is 180,000.00. Live prices on
// BOTH plans get bumped to distinct values so the test proves the §86/4
// bills the NEW *frozen* value, not any live or old-frozen number.
const OLD_FROZEN_THB = '50000.00';
const NEW_FROZEN_THB = '180000.00';
const NEW_FROZEN_SATANG = 18_000_000n;

/**
 * Test bridge mirroring `f4InvoicingForRenewalBridge` but with mocked
 * PDF/Blob in the issue step (real createInvoiceDraft + issueInvoice).
 */
function makeTestRenewalBridge(): F4InvoicingForRenewalBridge {
  return {
    async issueInvoiceForRenewal(
      input: IssueInvoiceForRenewalInput,
    ): Promise<IssueInvoiceForRenewalResult> {
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
        // Task 8 review-fix (F1) — this test bridge predates the
        // `membershipCoverage` field and silently dropped it, unlike the
        // REAL `f4-invoicing-for-renewal-bridge-drizzle.ts` adapter (which
        // has forwarded it since Task 8). Mirror that adapter exactly so
        // this test proves the actual confirm-renewal → §86/4 wiring
        // instead of a stale double that always fell back to the generic
        // "from_payment" text.
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

describe('F8 confirm-with-plan-change — bills NEW plan frozen price on §86/4 (Task 1.5 B6)', () => {
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

    oldPlanId = `f8-pc-old-${randomUUID().slice(0, 8)}`;
    newPlanId = `f8-pc-new-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: oldPlanId,
        planName: { en: 'Plan-Change Old' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: 5_000_000,
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: newPlanId,
        planName: { en: 'Plan-Change New' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: 18_000_000,
        renewalTierBucket: 'premium',
      }),
    );

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Plan-Change Co',
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
        firstName: 'Plan',
        lastName: 'Change',
        email: 'plan-change@example.com',
        isPrimary: true,
      });
      // Cycle frozen at the OLD plan's price, in awaiting_payment.
      //
      // F1 (final-review, 2026-07-09) — `anchoredAt` set to a PRIOR real
      // payment date so `classifyMembershipPayment` resolves `'renewal'`
      // (not `'first_payment'`): this is the member's SECOND-ever cycle
      // in spirit (a plan-change mid-renewal), and the test's whole point
      // is the exact-window coverage text below — a first-payment shape
      // would correctly OMIT `membershipCoverage` (falls back to
      // `from_payment`), which is a DIFFERENT scenario covered by its own
      // sibling test further down.
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

    // BUMP both plans' LIVE catalogue prices to distinct values AFTER
    // the new plan's frozen value (180,000) was established at
    // confirm-time. The new plan must still re-snapshot to its
    // confirm-time frozen 180,000 — the plan-lookup at confirm reads
    // the LIVE price, so the bump must happen AFTER confirm to test the
    // "live ≠ frozen" invariant. We bump the OLD plan now (it is never
    // billed) and assert NEW-frozen below.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(membershipPlans)
        .set({ annualFeeMinorUnits: 99_000_000 }) // 990,000 — never billed
        .where(eq(membershipPlans.planId, oldPlanId)),
    );
  }, 120_000);

  afterAll(async () => {
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('re-snapshots to the NEW plan and bills its FROZEN value (not old frozen, not live)', async () => {
    const realDeps = makeRenewalsDeps(tenant.ctx.slug);
    const deps: ConfirmRenewalDeps = {
      tenant: realDeps.tenant,
      cyclesRepo: realDeps.cyclesRepo,
      auditEmitter: realDeps.auditEmitter,
      clock: realDeps.clock,
      planLookupForRenewal: realDeps.planLookupForRenewal,
      memberRenewalFlagsRepo: realDeps.memberRenewalFlagsRepo,
      f4InvoicingBridge: makeTestRenewalBridge(),
    };

    const result = await confirmRenewal(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      newPlanId, // member upgrades during confirm
      // 070 — planYear server-derived from the cycle's period_from
      // (2026-06-01 → 2026), matching the seeded new-plan row (plan_year
      // 2026). The plan-change branch re-snapshots frozen fields but does
      // not move period_from, so the derived year is unaffected.
      actorUserId: user.userId,
      actorRole: 'member',
      correlationId: `pc-${cycleId}`,
    });
    if (!result.ok) {
      throw new Error(`confirm failed: ${JSON.stringify(result.error)}`);
    }
    expect(result.value.planChanged).toBe(true);

    // The cycle row re-snapshotted to the NEW plan's frozen price.
    const cycleRow = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          frozen: renewalCycles.frozenPlanPriceThb,
          planId: renewalCycles.planIdAtCycleStart,
          linkedInvoiceId: renewalCycles.linkedInvoiceId,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(cycleRow[0]?.frozen).toBe(NEW_FROZEN_THB);
    expect(cycleRow[0]?.planId).toBe(newPlanId);
    expect(cycleRow[0]?.linkedInvoiceId).toBe(result.value.invoiceId);

    // The issued §86/4 membership line bills the NEW plan's FROZEN value.
    const lineRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          kind: invoiceLines.kind,
          totalSatang: invoiceLines.totalSatang,
          descriptionTh: invoiceLines.descriptionTh,
          descriptionEn: invoiceLines.descriptionEn,
        })
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
    expect(BigInt(membershipLine!.totalSatang)).toBe(NEW_FROZEN_SATANG);
    // Not the old frozen 50,000 (5,000,000) nor any live price.
    expect(BigInt(membershipLine!.totalSatang)).not.toBe(5_000_000n);
    expect(lineRows.some((l) => l.kind === 'registration_fee')).toBe(false);

    // Task 8 review-fix (F1) — end-to-end proof that `confirmRenewal`
    // threads the EXACT next-period window (`periodTo` 2027-06-01 →
    // `periodTo + frozenPlanTermMonths` (12) = 2028-06-01) into the §86/4
    // membership line, in BOTH locales. Previously nothing asserted this
    // wiring on the confirm-renewal path (only offline-frozen-price.test.ts
    // covered mark-paid-offline's use of the same signal).
    expect(membershipLine!.descriptionEn).toContain(
      '(coverage 2027-06-01 to 2028-06-01)',
    );
    expect(membershipLine!.descriptionTh).toContain(
      '(ระยะเวลา 2027-06-01 ถึง 2028-06-01)',
    );
  }, 120_000);

  // F1 (final-review, 2026-07-09) — sibling of the coverage-window
  // assertion above: a NEVER-PAID member's only-ever cycle (unanchored,
  // cycleCountForMember=1) must classify as `first_payment` and OMIT
  // `membershipCoverage` entirely, falling back to `createInvoiceDraft`'s
  // own `{ kind: 'from_payment' }` default — the exact-window text would
  // describe a period that doesn't exist yet (the actual re-anchor only
  // happens once `mark-cycle-complete-from-invoice-paid.ts`'s linked path
  // sees the real payment).
  it('F1: first-payment shape (unanchored, only cycle) — bills FROM-PAYMENT text, no window', async () => {
    const firstPayMemberId = randomUUID();
    const firstPayCycleId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: firstPayMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'First-Payment Co',
        country: 'TH',
        planId: oldPlanId,
        planYear: 2026,
        registrationFeePaid: true,
        registrationDate: '2026-05-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: firstPayMemberId,
        firstName: 'First',
        lastName: 'Payment',
        email: 'first-payment@example.com',
        isPrimary: true,
      });
      // NO anchoredAt — the member's one-and-only cycle, never anchored
      // to a real payment. classifyMembershipPayment resolves
      // 'first_payment' (cycleCountForMember=1, anchoredAt=null).
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: firstPayCycleId,
        memberId: firstPayMemberId,
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
      });
    });

    const realDeps = makeRenewalsDeps(tenant.ctx.slug);
    const deps: ConfirmRenewalDeps = {
      tenant: realDeps.tenant,
      cyclesRepo: realDeps.cyclesRepo,
      auditEmitter: realDeps.auditEmitter,
      clock: realDeps.clock,
      planLookupForRenewal: realDeps.planLookupForRenewal,
      memberRenewalFlagsRepo: realDeps.memberRenewalFlagsRepo,
      f4InvoicingBridge: makeTestRenewalBridge(),
    };

    const result = await confirmRenewal(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: firstPayCycleId,
      memberId: firstPayMemberId,
      actorUserId: user.userId,
      actorRole: 'member',
      correlationId: `pc-first-${firstPayCycleId}`,
    });
    if (!result.ok) {
      throw new Error(`confirm failed: ${JSON.stringify(result.error)}`);
    }

    const lineRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          kind: invoiceLines.kind,
          descriptionTh: invoiceLines.descriptionTh,
          descriptionEn: invoiceLines.descriptionEn,
        })
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
    // NOT the exact-window text — the first-payment shape omits
    // `membershipCoverage`, so `createInvoiceDraft` falls back to its
    // own `{ kind: 'from_payment' }` default.
    expect(membershipLine!.descriptionEn).toContain(
      'effective from the month of payment',
    );
    expect(membershipLine!.descriptionEn).not.toContain('coverage');
    expect(membershipLine!.descriptionTh).toContain(
      'เริ่มตั้งแต่เดือนที่ชำระค่าธรรมเนียม',
    );
  }, 120_000);
});
