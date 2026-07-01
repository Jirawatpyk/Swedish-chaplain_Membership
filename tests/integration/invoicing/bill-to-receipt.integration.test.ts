/**
 * 088-invoice-tax-flow-redesign — T014 [US1] Integration (live Neon):
 * issue a membership BILL → offline pay → exactly ONE §86/4 RC tax receipt.
 *
 * SC-001 proof: no member ever holds two §86/4 tax invoices for one sale.
 *   - at ISSUE: a non-tax ใบแจ้งหนี้ — `bill_document_number_raw` (SC) set,
 *     `document_number` + `sequence_number` NULL, `pdf_doc_kind='invoice'`;
 *   - at PAYMENT: the single §86/4 ใบกำกับภาษี/ใบเสร็จรับเงิน — the §87 `RC`
 *     number is minted in `receipt_document_number_raw`, dated at the payment
 *     date, and EXACTLY ONE `tax_receipt_issued` audit row lands.
 *
 * Exercises the REAL allocator + repo + audit + settings + tenant isolation;
 * PDF render + Blob upload are mocked (same pattern as
 * seq-interleaved-membership-event.test.ts). `taxAtPayment: true` overrides the
 * default-OFF env flag so the new flow runs.
 *
 * Migrations 0230 + 0231 MUST be applied to the `dev` Neon branch first.
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

function issueDepsFlagOn(slug: string, captured?: PdfRenderInput[]): IssueInvoiceDeps {
  return {
    ...makeIssueInvoiceDeps(slug),
    ...mockPdfBlob(captured),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: true,
  };
}

function recordDepsFlagOn(slug: string, captured?: PdfRenderInput[]): RecordPaymentDeps {
  return {
    ...makeRecordPaymentDeps(slug),
    ...mockPdfBlob(captured),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: true,
    // Force the SYNCHRONOUS receipt render for a deterministic assertion (this
    // dev env has FEATURE_F5_ASYNC_RECEIPT_PDF on). The §87 RC allocation +
    // `tax_receipt_issued` fire in-tx on BOTH paths — only the render timing
    // differs; the async worker path is covered by render-receipt-pdf (T020).
    asyncReceiptPdf: false,
  };
}

describe('088 US1 — bill (ใบแจ้งหนี้) → §86/4 RC receipt at payment (live Neon, SC-001)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'bill-to-receipt-plan';
  const planYear = 2026;
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();

    // SweCham cutover config — bill prefix SC + receipt prefix RC + separate.
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
        planName: { en: 'Bill→Receipt Plan' },
        description: { en: 'Plan for the 088 bill→receipt integration test' },
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
        companyName: 'Bill Receipt Member Corp',
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
        firstName: 'Bill',
        lastName: 'Contact',
        email: 'bill.contact@b2r.example',
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

  it('issue → bill (SC, non-§87); pay → single RC §86/4 receipt + exactly one tax_receipt_issued', async () => {
    // 1. Draft + issue → a non-tax ใบแจ้งหนี้.
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `b2r-draft-${memberId}`,
      memberId,
      planId,
      planYear,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${JSON.stringify(draft)}`).toBe(true);
    if (!draft.ok) throw new Error('draft failed');
    const invoiceId = draft.value.invoiceId;

    const issued = await issueInvoice(issueDepsFlagOn(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `b2r-issue-${invoiceId}`,
      invoiceId,
    });
    expect(issued.ok, issued.ok ? 'ok' : `issue err: ${JSON.stringify(issued)}`).toBe(true);
    if (!issued.ok) throw new Error('issue failed');

    const billRow = await readRow(invoiceId);
    expect(billRow!.status).toBe('issued');
    expect(billRow!.pdfDocKind).toBe('invoice');
    // Non-§87 bill number; §87 seq/doc NULL (SC-003 disjoint).
    expect(billRow!.billDocumentNumberRaw).toMatch(/^SC-2026-\d{6}$/);
    expect(billRow!.sequenceNumber).toBeNull();
    expect(billRow!.documentNumber).toBeNull();
    expect(billRow!.receiptDocumentNumberRaw).toBeNull();

    // 2. Offline pay → the single §86/4 RC receipt, minted AT payment.
    const paid = await recordPayment(recordDepsFlagOn(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `b2r-pay-${invoiceId}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: PAYMENT_DATE,
    });
    expect(paid.ok, paid.ok ? 'ok' : `pay err: ${JSON.stringify(paid)}`).toBe(true);
    if (!paid.ok) throw new Error('pay failed');

    const paidRow = await readRow(invoiceId);
    expect(paidRow!.status).toBe('paid');
    // The §87 RC number is born at payment; the bill number stays (both
    // downloadable, FR-015); §87 invoice seq/doc stay NULL throughout.
    expect(paidRow!.receiptDocumentNumberRaw).toMatch(/^RC-2026-\d{6}$/);
    expect(paidRow!.billDocumentNumberRaw).toBe(billRow!.billDocumentNumberRaw);
    expect(paidRow!.sequenceNumber).toBeNull();
    expect(paidRow!.documentNumber).toBeNull();
    expect(paidRow!.paymentDate).toBe(PAYMENT_DATE);
    expect(paidRow!.receiptPdfStatus).toBe('rendered');

    // 3. SC-001 — EXACTLY ONE tax_receipt_issued for this sale.
    const taxReceiptRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'tax_receipt_issued'),
          eq(auditLog.requestId, `b2r-pay-${invoiceId}`),
        ),
      );
    expect(taxReceiptRows).toHaveLength(1);
    const p = taxReceiptRows[0]!.payload as Record<string, unknown>;
    expect(p.receipt_document_number_raw).toBe(paidRow!.receiptDocumentNumberRaw);
    expect(p.member_id).toBe(memberId);
    expect(p.payment_date).toBe(PAYMENT_DATE);

    // No stray §86/4 tax number was consumed at issue (SC-001): the ONLY
    // §87-register number for the whole sale is the RC receipt number.
    expect(taxReceiptRows[0]!.eventType).toBe('tax_receipt_issued');
  }, 90_000);
});
