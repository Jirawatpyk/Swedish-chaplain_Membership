/**
 * 088-invoice-tax-flow-redesign — T015 [US1] Integration (live Neon):
 * online (Stripe passthrough) + offline payments produce IDENTICAL receipt
 * kind / numbering stream / dating (FR-005).
 *
 * The online (Stripe) chain is a verified PURE passthrough
 * `confirm-payment → invoicing-bridge → markPaidFromProcessor → recordPayment`
 * (it only maps `settlementDate → paymentDate`, `method → 'other' +
 * processorMethod`, `triggeredBy → 'webhook'`). So FR-005 parity reduces to:
 * `recordPayment` mints the SAME §86/4 RC receipt (kind `receipt_combined`,
 * `RC` stream, dated at the payment date, one `tax_receipt_issued`) whether the
 * payment arrives OFFLINE (admin `bank_transfer`) or ONLINE (webhook, method
 * `other` + `processorMethod:'stripe_card'`). This test drives both shapes
 * through `recordPayment` with `taxAtPayment: true` and asserts the receipt
 * kind / prefix / dating are identical.
 *
 * REAL allocator + repo + audit; PDF/Blob mocked. Migrations 0230 + 0231 first.
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
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeRecordPaymentDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
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

function mockPdfBlob(captured: PdfRenderInput[]) {
  return {
    pdfRender: {
      render: vi.fn(async (i: PdfRenderInput) => {
        captured.push(i);
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

function issueDeps(slug: string) {
  return {
    ...makeIssueInvoiceDeps(slug),
    ...mockPdfBlob([]),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on' as const,
  };
}
function recordDeps(slug: string, captured: PdfRenderInput[]) {
  return {
    ...makeRecordPaymentDeps(slug),
    ...mockPdfBlob(captured),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on' as const,
    asyncReceiptPdf: false,
  };
}

describe('088 US1 — online (Stripe passthrough) + offline payment parity (live Neon, FR-005)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'parity-plan';
  const planYear = 2026;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
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
        planName: { en: 'Parity Plan' },
        description: { en: 'Plan for the 088 online/offline parity test' },
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
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function seedMember(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Parity Member ${memberId.slice(0, 8)}`,
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
        firstName: 'Parity',
        lastName: 'Member',
        email: `parity.${memberId.slice(0, 8)}@member.example`,
        isPrimary: true,
      });
    });
    return memberId;
  }

  async function issueBill(memberId: string, tag: string): Promise<string> {
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `parity-draft-${tag}-${memberId}`,
      memberId,
      planId,
      planYear,
    });
    if (!draft.ok) throw new Error(`draft ${tag}: ${draft.error.code}`);
    const invoiceId = draft.value.invoiceId;
    const issued = await issueInvoice(issueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `parity-issue-${tag}-${invoiceId}`,
      invoiceId,
    });
    if (!issued.ok) throw new Error(`issue ${tag}: ${JSON.stringify(issued)}`);
    return invoiceId;
  }

  it('offline (bank_transfer) + online (webhook/stripe passthrough) yield identical §86/4 receipt kind + RC stream + dating', async () => {
    const memberOffline = await seedMember();
    const memberOnline = await seedMember();
    const offlineInvoiceId = await issueBill(memberOffline, 'offline');
    const onlineInvoiceId = await issueBill(memberOnline, 'online');

    // OFFLINE — admin bank transfer.
    const offCap: PdfRenderInput[] = [];
    const offline = await recordPayment(recordDeps(tenant.ctx.slug, offCap), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `parity-pay-offline-${offlineInvoiceId}`,
      invoiceId: offlineInvoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: PAYMENT_DATE,
      triggeredBy: 'admin_manual',
    });
    expect(offline.ok, offline.ok ? 'ok' : JSON.stringify(offline)).toBe(true);
    if (!offline.ok) throw new Error('offline pay failed');

    // ONLINE — exactly what the Stripe bridge (`markPaidFromProcessor`) maps
    // onto recordPayment: method 'other' + processorMethod + triggeredBy webhook
    // + paymentDate = settlement date.
    const onCap: PdfRenderInput[] = [];
    const online = await recordPayment(recordDeps(tenant.ctx.slug, onCap), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `parity-pay-online-${onlineInvoiceId}`,
      invoiceId: onlineInvoiceId,
      paymentMethod: 'other',
      processorMethod: 'stripe_card',
      triggeredBy: 'webhook',
      paymentDate: PAYMENT_DATE,
      suppressReceiptEmail: true,
    });
    expect(online.ok, online.ok ? 'ok' : JSON.stringify(online)).toBe(true);
    if (!online.ok) throw new Error('online pay failed');

    // Identical receipt KIND (both §86/4 receipt_combined).
    expect(offCap[0]!.kind).toBe('receipt_combined');
    expect(onCap[0]!.kind).toBe(offCap[0]!.kind);

    // Identical DATING — both dated at the payment date (D7).
    expect(offCap[0]!.issueDate).toBe(PAYMENT_DATE);
    expect(onCap[0]!.issueDate).toBe(offCap[0]!.issueDate);

    // Identical NUMBERING STREAM — both RC §87 receipt numbers (sequence differs
    // by one; the format/prefix/dating are identical — FR-005).
    const offRc = offline.value.receiptDocumentNumberRaw;
    const onRc = online.value.receiptDocumentNumberRaw;
    expect(offRc).toMatch(/^RC-2026-\d{6}$/);
    expect(onRc).toMatch(/^RC-2026-\d{6}$/);

    // §87 invoice-stream pair stays NULL on both (bills were non-§87).
    expect(offline.value.documentNumber).toBeNull();
    expect(online.value.documentNumber).toBeNull();

    // Both fired exactly one tax_receipt_issued (SC-001) — identical event.
    for (const [reqId, memberId, rc] of [
      [`parity-pay-offline-${offlineInvoiceId}`, memberOffline, offRc],
      [`parity-pay-online-${onlineInvoiceId}`, memberOnline, onRc],
    ] as const) {
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'tax_receipt_issued'),
            eq(auditLog.requestId, reqId),
          ),
        );
      expect(rows, `one tax_receipt_issued for ${reqId}`).toHaveLength(1);
      const p = rows[0]!.payload as Record<string, unknown>;
      expect(p.receipt_document_number_raw).toBe(rc);
      expect(p.member_id).toBe(memberId);
      expect(p.payment_date).toBe(PAYMENT_DATE);
    }

    // Both rows landed paid + rendered identically.
    const [offRow] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, offlineInvoiceId)));
    const [onRow] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, onlineInvoiceId)));
    // The main pdf_doc_kind stays 'invoice' (the bill); the §86/4 receipt is a
    // SEPARATE artifact (receiptPdf*). Parity = identical on both paths.
    expect(offRow!.pdfDocKind).toBe('invoice');
    expect(onRow!.pdfDocKind).toBe(offRow!.pdfDocKind);
    expect(offRow!.receiptPdfStatus).toBe('rendered');
    expect(onRow!.receiptPdfStatus).toBe(offRow!.receiptPdfStatus);
    expect(offRow!.paymentDate).toBe(PAYMENT_DATE);
    expect(onRow!.paymentDate).toBe(PAYMENT_DATE);
  }, 120_000);
});
