/**
 * 088-invoice-tax-flow-redesign — T069 [US1 AS5 / FR-018] Integration (live Neon):
 * a RENEWAL-generated (F8) membership invoice follows the SAME bill → §86/4
 * tax-receipt-at-payment model.
 *
 * The renewal rails (confirm-renewal / mark-paid-offline / admin-renew-lapsed)
 * compose the F4 use-cases via bridges: `createInvoiceDraft({ renewalSignal:
 * { unitPriceSatang } })` → `issueInvoice` → `recordPayment`. This test drives
 * that exact composition (frozen-price renewal signal = the renewal-specific
 * bit) with the `taxAtPayment` override — the online/offline bridges build
 * their own F4 deps from the env flag (frozen at boot), so the flow is exercised
 * at the use-case seam the bridges delegate to.
 *
 * Proves (FR-018):
 *   - at ISSUE: a non-tax ใบแจ้งหนี้ — `bill_document_number_raw` (SC) set,
 *     `document_number` + `sequence_number` NULL, `pdf_doc_kind='invoice'`, NO
 *     §87 number consumed; billed at the FROZEN renewal price (no reg-fee);
 *   - the bridge's number resolution surfaces the SC bill number at issue
 *     (`billDocumentNumberRaw ?? documentNumber?.raw`) — NEVER '';
 *   - at PAYMENT (offline rail): exactly ONE §86/4 `RC` tax receipt minted in
 *     `receipt_document_number_raw` + exactly one `tax_receipt_issued` audit;
 *   - the post-payment surface resolves the RC (`receiptDocumentNumberRaw ??
 *     documentNumber?.raw`) — the renewal success screen's receipt reference.
 *
 * PDF render + Blob upload are mocked (same pattern as bill-to-receipt).
 * Migrations 0230 + 0231 (+ 0234 for vat_treatment) MUST be applied to `dev`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeRecordPaymentDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

const FIXED_NOW = '2026-07-01T09:00:00Z';
const PAYMENT_DATE = '2026-07-01';
// FR-022 — the cycle's FROZEN VAT-exclusive membership price the renewal rails
// thread as `renewalSignal.unitPriceSatang` (12,000.00 THB). Distinct from the
// live catalogue path so this test proves the renewal-specific composition.
const FROZEN_PRICE_SATANG = 1_200_000n;
const EXPECTED_VAT_SATANG = 84_000n; // 7% of 12,000.00

function mockPdfBlob(captured?: PdfRenderInput[]) {
  return {
    pdfRender: {
      render: vi.fn(async (renderInput: PdfRenderInput) => {
        captured?.push(renderInput);
        return {
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
        };
      }),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
  };
}

function issueDepsFlagOn(slug: string): IssueInvoiceDeps {
  return {
    ...makeIssueInvoiceDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: true,
  };
}

function recordDepsFlagOn(slug: string): RecordPaymentDeps {
  return {
    ...makeRecordPaymentDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: true,
    // Force the SYNCHRONOUS receipt render for a deterministic assertion (the
    // §87 RC allocation + `tax_receipt_issued` fire in-tx on BOTH paths).
    asyncReceiptPdf: false,
  };
}

describe('088 T069 — renewal parity: bill (ใบแจ้งหนี้) → §86/4 RC at payment (live Neon, FR-018)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'renewal-parity-plan';
  const planYear = 2026;
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();

    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thailand-Swedish Chamber of Commerce',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear,
        planName: { en: 'Renewal Parity Plan' },
        description: { en: 'Plan for the 088 renewal-parity integration test' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_200_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Renewal Parity Member Corp',
        country: 'TH',
        taxId: '9999999999999',
        addressLine1: '99 Rama IV Road',
        city: 'Sathon',
        province: 'Bangkok',
        postalCode: '10120',
        planId,
        planYear,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Renewal',
        lastName: 'Contact',
        email: 'renewal.contact@parity.example',
        isPrimary: true,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function readRow(invoiceId: string) {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row;
  }

  it('renewal issue → SC bill (frozen price, no §87); offline pay → single RC §86/4 receipt', async () => {
    // 1. Renewal draft — the FROZEN-price signal is the renewal-specific bit
    //    (FR-022): the membership line bills `renewalSignal.unitPriceSatang`,
    //    NOT the live catalogue price, and the one-off reg-fee is suppressed.
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `rp-draft-${memberId}`,
      memberId,
      planId,
      planYear,
      renewalSignal: { unitPriceSatang: FROZEN_PRICE_SATANG },
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${JSON.stringify(draft)}`).toBe(true);
    if (!draft.ok) throw new Error('draft failed');
    const invoiceId = draft.value.invoiceId;

    // 2. Issue → a non-tax ใบแจ้งหนี้ (SC), NO §87 number at issue.
    const issued = await issueInvoice(issueDepsFlagOn(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `rp-issue-${invoiceId}`,
      invoiceId,
    });
    expect(issued.ok, issued.ok ? 'ok' : `issue err: ${JSON.stringify(issued)}`).toBe(true);
    if (!issued.ok) throw new Error('issue failed');

    const billRow = await readRow(invoiceId);
    expect(billRow!.status).toBe('issued');
    expect(billRow!.pdfDocKind).toBe('invoice');
    expect(billRow!.billDocumentNumberRaw).toMatch(/^SC-2026-\d{6}$/);
    expect(billRow!.sequenceNumber).toBeNull();
    expect(billRow!.documentNumber).toBeNull();
    expect(billRow!.receiptDocumentNumberRaw).toBeNull();
    // FR-022 — billed at the FROZEN renewal price (VAT computed on top).
    expect(BigInt(billRow!.subtotalSatang as unknown as string)).toBe(FROZEN_PRICE_SATANG);
    expect(BigInt(billRow!.vatSatang as unknown as string)).toBe(EXPECTED_VAT_SATANG);

    // The renewal bridge surfaces THIS number onto the audit + success screen.
    // Resolve it exactly as the bridge does, on the real domain Invoice —
    // NEVER '' (the flag-ON blank) nor '[object Object]' (a value-object leak).
    const surfacedAtIssue =
      issued.value.billDocumentNumberRaw ?? issued.value.documentNumber?.raw ?? '';
    expect(surfacedAtIssue).toBe(billRow!.billDocumentNumberRaw);
    expect(surfacedAtIssue).not.toBe('');

    // 3. Offline pay (the mark-paid-offline rail) → the single §86/4 RC receipt.
    const paid = await recordPayment(recordDepsFlagOn(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `rp-pay-${invoiceId}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: PAYMENT_DATE,
    });
    expect(paid.ok, paid.ok ? 'ok' : `pay err: ${JSON.stringify(paid)}`).toBe(true);
    if (!paid.ok) throw new Error('pay failed');

    const paidRow = await readRow(invoiceId);
    expect(paidRow!.status).toBe('paid');
    expect(paidRow!.receiptDocumentNumberRaw).toMatch(/^RC-2026-\d{6}$/);
    // The bill number stays (both docs downloadable, FR-015); §87 seq/doc NULL.
    expect(paidRow!.billDocumentNumberRaw).toBe(billRow!.billDocumentNumberRaw);
    expect(paidRow!.sequenceNumber).toBeNull();
    expect(paidRow!.documentNumber).toBeNull();
    expect(paidRow!.paymentDate).toBe(PAYMENT_DATE);
    expect(paidRow!.receiptPdfStatus).toBe('rendered');

    // The renewal success screen references the RC after payment — resolve it
    // as the success page's paid+rendered branch does, on the domain Invoice.
    const surfacedReceipt =
      paid.value.receiptDocumentNumberRaw ?? paid.value.documentNumber?.raw ?? '';
    expect(surfacedReceipt).toBe(paidRow!.receiptDocumentNumberRaw);
    expect(surfacedReceipt).not.toBe('');

    // 4. FR-018 / SC-001 — EXACTLY ONE §86/4 tax number for the whole renewal
    //    sale: the RC minted at payment (never a stray §87 at issue).
    const taxReceiptRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'tax_receipt_issued'),
          eq(auditLog.requestId, `rp-pay-${invoiceId}`),
        ),
      );
    expect(taxReceiptRows).toHaveLength(1);
    const p = taxReceiptRows[0]!.payload as Record<string, unknown>;
    expect(p.receipt_document_number_raw).toBe(paidRow!.receiptDocumentNumberRaw);
    expect(p.member_id).toBe(memberId);
    expect(p.payment_date).toBe(PAYMENT_DATE);
  }, 90_000);
});
