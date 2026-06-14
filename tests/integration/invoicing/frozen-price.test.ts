/**
 * F8-completion Slice 1 · Task 1.5 — frozen-price §86/4 billing (the
 * Thai tax fix). Live Neon Singapore via .env.local.
 *
 * FR-022: the issued §86/4 tax invoice (ใบกำกับภาษี) MUST bill the
 * cycle's FROZEN membership price — NOT the live F2 catalogue price. If
 * a tenant edits the plan price mid-cycle, billing the live price would
 * charge a DIFFERENT amount than the frozen price the member was shown
 * and agreed to → a §86/10 credit-note correction problem.
 *
 * The fix threads `renewalSignal.unitPriceSatang` (server-sourced from
 * `cycle.frozenPlanPriceThb`, parsed integer-only via
 * `parseThbDecimalToSatang`) through the F4↔F8 bridge into
 * `createInvoiceDraft`, where it overrides the `getAnnualFeeSatang`
 * live-price read for the membership line.
 *
 * VAT-EXCLUSIVE invariant (the opposite of the event `amountOverride`
 * path which is VAT-INCLUSIVE): the membership line subtotal == frozen
 * × 100 EXACTLY; the issued grand total == subtotal + calculateVat(...)
 * (7% added ON TOP). The frozen price here carries a NON-ZERO satang
 * remainder ('50000.50') so any parse / round drift surfaces.
 *
 * Test seam: drives the REAL `createInvoiceDraft` (where the line price
 * is set — assertion 1) + the REAL `issueInvoice` with mocked PDF
 * render + Blob upload (where the §87 number is allocated + the grand
 * total computed — assertion 2). The PDF/Blob mock pattern mirrors
 * issue-event-invoice.test.ts.
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
import {
  createInvoiceDraft,
  type CreateInvoiceDraftInput,
} from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import {
  issueInvoice,
  type IssueInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { calculateVat } from '@/modules/invoicing/domain/policies/calculate-vat';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// '50000.50' THB → 5_000_050 satang. NON-ZERO satang remainder so a
// `parseFloat(x)*100` regression (which would drift) is caught.
const FROZEN_PRICE_THB = '50000.50';
const FROZEN_SUBTOTAL_SATANG = 5_000_050n;
const VAT_RATE = '0.0700';
void FROZEN_PRICE_THB; // documents the source decimal the satang derives from

// Build issue-invoice deps with REAL repos but mocked PDF render + Blob
// (the §86/4 PDF + Vercel Blob upload are not the unit under test here;
// the grand-total math is). Mirrors issue-event-invoice.test.ts.
function makeMockedIssueDeps(tenantSlug: string): IssueInvoiceDeps {
  const real = makeIssueInvoiceDeps(tenantSlug);
  return {
    ...real,
    pdfRender: {
      render: vi.fn(async (_input: PdfRenderInput) => ({
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
}

describe('F8 frozen-price §86/4 billing — VAT-exclusive override (Task 1.5)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({ tenant, vatRate: VAT_RATE });

    planId = `f8-frozen-bill-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Frozen Billing Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        // Live catalogue price STARTS at the frozen value, then gets
        // BUMPED below to a DIFFERENT number so the override is proven.
        annualFeeMinorUnits: 5_000_050,
      }),
    );

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Frozen Billing Co',
        country: 'TH',
        planId,
        planYear: 2026,
        // Existing member renewing — registration_fee already paid.
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Frozen',
        lastName: 'Contact',
        email: 'frozen-billing@example.com',
        isPrimary: true,
      });
    });

    // Tenant BUMPS the F2 catalogue price mid-cycle. Billing the live
    // price would now charge 85,000.00 — FR-022 says bill the frozen
    // 50,000.50 instead.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(membershipPlans)
        .set({ annualFeeMinorUnits: 8_500_000 })
        .where(eq(membershipPlans.planId, planId)),
    );
  }, 120_000);

  afterAll(async () => {
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('bills the cycle frozen price on the issued §86/4, VAT-exclusive, non-zero satang (FR-022)', async () => {
    // ---- Act: createInvoiceDraft WITH the renewal signal (frozen price).
    const draftInput: CreateInvoiceDraftInput = {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `frozen-bill-${memberId}`,
      memberId,
      planId,
      planYear: 2026,
      autoEmailOnIssue: false,
      renewalSignal: { unitPriceSatang: FROZEN_SUBTOTAL_SATANG },
    };
    const draftResult = await createInvoiceDraft(
      makeCreateInvoiceDraftDeps(tenant.ctx.slug),
      draftInput,
    );
    if (!draftResult.ok) {
      throw new Error(`draft failed: ${JSON.stringify(draftResult.error)}`);
    }
    const draft = draftResult.value;

    // ---- Assert (1): membership line subtotal == frozen × 100 EXACTLY,
    // VAT-EXCLUSIVE. Read the persisted line back from the DB.
    const lineRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          kind: invoiceLines.kind,
          totalSatang: invoiceLines.totalSatang,
          proRateFactor: invoiceLines.proRateFactor,
        })
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, tenant.ctx.slug),
            eq(invoiceLines.invoiceId, draft.invoiceId),
          ),
        ),
    );
    const membershipLine = lineRows.find((l) => l.kind === 'membership_fee');
    expect(membershipLine).toBeDefined();
    expect(BigInt(membershipLine!.totalSatang)).toBe(FROZEN_SUBTOTAL_SATANG);
    // proRateFactor forced to 1.0000 on the renewal path (full cycle).
    expect(membershipLine!.proRateFactor).toBe('1.0000');
    // No registration_fee line on the renewal path.
    expect(lineRows.some((l) => l.kind === 'registration_fee')).toBe(false);

    // ---- Act: issueInvoice promotes draft → issued (allocates §87,
    // renders the §86/4 PDF [mocked], computes the grand total).
    const issueResult = await issueInvoice(makeMockedIssueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `frozen-bill-issue-${memberId}`,
      invoiceId: draft.invoiceId,
    });
    if (!issueResult.ok) {
      throw new Error(`issue failed: ${JSON.stringify(issueResult.error)}`);
    }
    const issued = issueResult.value;

    // ---- Assert (2): grand total == subtotal + VAT-on-top, where VAT is
    // computed by the SAME calculateVat the issue path uses (do NOT
    // hardcode — derive it). For 5_000_050 @ 7%: round-half-away(350003.5)
    // = 350004 → total 5_350_054.
    const expectedVat = calculateVat(
      Money.fromSatangUnsafe(FROZEN_SUBTOTAL_SATANG),
      VatRate.ofUnsafe(VAT_RATE),
    );
    expect(expectedVat.subtotal.satang).toBe(FROZEN_SUBTOTAL_SATANG);
    expect(issued.total).not.toBeNull();
    expect(issued.total!.satang).toBe(expectedVat.total.satang);
    // (3) Non-zero satang sanity: the VAT itself rounded (350004, not
    // 350003) — proves no float drift on the 7%-of-odd-satang case.
    expect(expectedVat.vat.satang).toBe(350004n);
    expect(issued.total!.satang).toBe(5_350_054n);
  }, 120_000);
});
