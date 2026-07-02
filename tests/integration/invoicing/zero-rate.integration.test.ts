/**
 * 088-invoice-tax-flow-redesign (T053 / US8 / SC-008 / AS1-4) — live-Neon
 * end-to-end proof of the §80/1(5) embassy / int'l-org VAT zero-rate.
 *
 *   AS1/AS3 — a zero-rate (event/service) sale → non-tax bill at VAT 0% with the
 *     treatment + MFA cert PINNED, then a payment-time §86/4 RC tax receipt at
 *     vat_amount 0 carrying the §80/1(5) note + cert reference. The receipt PDF
 *     is rendered with the REAL @react-pdf adapter and pdf-parsed so this is a
 *     genuine SC-008 proof, not just a data-flow assertion.
 *   AS2 — a zero-rate issue with NO cert number is BLOCKED (fail-closed).
 *   AS4 — a membership invoice STAYS VAT 7% and REJECTS a zero-rate attempt.
 *
 * Exercises the REAL allocator + repo + audit + settings + template; only Blob
 * upload is mocked (bytes captured for pdf-parse). `taxAtPayment: true` +
 * `asyncReceiptPdf: false` run the new flow with a deterministic sync render.
 *
 * Migrations 0230→0234 MUST be applied to the `dev` Neon branch first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { PDFParse } from 'pdf-parse';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import {
  makeCreateInvoiceDraftDeps,
  makeCreateEventInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeRecordPaymentDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
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
const CERT_NO = 'กต 0404/1234';
const CERT_DATE = '2026-03-10';
const RX_8015 = /80\/1\(5\)/;

function realRenderCapture(captured: Uint8Array[]) {
  return {
    pdfRender: reactPdfRenderAdapter,
    blob: {
      uploadPdf: vi.fn(async ({ key, body }: { key: string; body: Uint8Array }) => {
        captured.push(body);
        return { key, url: `https://blob.test/${key}` };
      }),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
  };
}

function issueDeps(slug: string, captured: Uint8Array[]): IssueInvoiceDeps {
  return {
    ...makeIssueInvoiceDeps(slug),
    ...realRenderCapture(captured),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: true,
  };
}

function recordDeps(slug: string, captured: Uint8Array[]): RecordPaymentDeps {
  return {
    ...makeRecordPaymentDeps(slug),
    ...realRenderCapture(captured),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: true,
    asyncReceiptPdf: false,
  };
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  return (await parser.getText()).text;
}

describe('088 US8 — §80/1(5) zero-rate (live Neon, SC-008)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'zero-rate-membership-plan';
  const planYear = 2026;
  let memberId: string;
  let eventId: string;
  let regZeroRate: string;
  let regNoCert: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();
    eventId = randomUUID();
    regZeroRate = randomUUID();
    regNoCert = randomUUID();

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
      // Membership plan + member (for the AS4 membership-stays-7% checks).
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear,
        planName: { en: 'Zero-Rate Membership Plan' },
        description: { en: 'Plan for the 088 zero-rate integration test' },
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
        companyName: 'Zero Rate Member Corp',
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
        firstName: 'Zero',
        lastName: 'Contact',
        email: 'zero.contact@zr.example',
        isPrimary: true,
      });

      // Event + two non-member registrations (embassy zero-rate service sales).
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `evt-zr-${eventId.slice(0, 8)}`,
        name: 'Embassy Expo Booth',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values([
        {
          tenantId: tenant.ctx.slug,
          eventId,
          registrationId: regZeroRate,
          externalId: `att-zr-${regZeroRate.slice(0, 8)}`,
          attendeeName: 'Sim Attaché',
          attendeeCompany: 'Embassy of Sweden (Simulated)',
          attendeeEmail: 'sim.zr@zr-embassy.test',
          matchType: 'non_member' as const,
          ticketType: 'Service',
          ticketPriceThb: 12000,
          paymentStatus: 'pending' as const,
          registeredAt: new Date('2026-01-20T03:00:00Z'),
        },
        {
          tenantId: tenant.ctx.slug,
          eventId,
          registrationId: regNoCert,
          externalId: `att-nc-${regNoCert.slice(0, 8)}`,
          attendeeName: 'Sim NoCert',
          attendeeCompany: 'Embassy of Nowhere (Simulated)',
          attendeeEmail: 'sim.nc@zr-embassy.test',
          matchType: 'non_member' as const,
          ticketType: 'Service',
          ticketPriceThb: 12000,
          paymentStatus: 'pending' as const,
          registeredAt: new Date('2026-01-20T03:00:00Z'),
        },
      ] satisfies NewEventRegistrationRow[]);
    });
  }, 90_000);

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

  const TIN_BUYER = {
    legal_name: 'Embassy of Sweden (Simulated)',
    tax_id: '0994000000001',
    address: '1 Wireless Rd, Bangkok',
    primary_contact_name: 'Sim Attaché',
    primary_contact_email: 'sim.zr@zr-embassy.test',
  } as const;

  it('AS1/AS3 — zero-rate bill (VAT 0, pinned cert) → §86/4 RC receipt with §80/1(5) note', async () => {
    // 1. Event draft (TIN buyer → bill→receipt flow, not §105 as-paid).
    const draft = await createEventInvoiceDraft(makeCreateEventInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zr-draft-${regZeroRate}`,
      eventRegistrationId: regZeroRate,
      amountOverride: 1_200_000, // 12,000.00 THB base
      buyer: TIN_BUYER,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${JSON.stringify(draft)}`).toBe(true);
    if (!draft.ok) throw new Error('draft failed');
    const invoiceId = draft.value.invoiceId;

    // 2. Issue as zero-rated with an MFA certificate → non-tax bill at VAT 0%.
    const billBytes: Uint8Array[] = [];
    const issued = await issueInvoice(issueDeps(tenant.ctx.slug, billBytes), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zr-issue-${invoiceId}`,
      invoiceId,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: CERT_NO,
      zeroRateCertDate: CERT_DATE,
    });
    expect(issued.ok, issued.ok ? 'ok' : `issue err: ${JSON.stringify(issued)}`).toBe(true);
    if (!issued.ok) throw new Error('issue failed');

    const billRow = await readRow(invoiceId);
    expect(billRow!.status).toBe('issued');
    expect(billRow!.pdfDocKind).toBe('invoice');
    expect(billRow!.billDocumentNumberRaw).toMatch(/^SC-2026-\d{6}$/);
    // VAT DRIVEN to 0% by the pinned treatment; total = base (AS1).
    expect(billRow!.vatTreatment).toBe('zero_rated_80_1_5');
    expect(billRow!.vatRateSnapshot).toBe('0.0000');
    expect(billRow!.vatSatang?.toString()).toBe('0');
    expect(billRow!.subtotalSatang?.toString()).toBe('1200000');
    expect(billRow!.totalSatang?.toString()).toBe('1200000');
    // Cert PINNED on the immutable issue-time row.
    expect(billRow!.zeroRateCertNo).toBe(CERT_NO);
    expect(billRow!.zeroRateCertDate).toBe(CERT_DATE);

    // 3. Pay → §86/4 RC tax receipt at VAT 0% + the §80/1(5) note.
    const receiptBytes: Uint8Array[] = [];
    const paid = await recordPayment(recordDeps(tenant.ctx.slug, receiptBytes), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zr-pay-${invoiceId}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: PAYMENT_DATE,
    });
    expect(paid.ok, paid.ok ? 'ok' : `pay err: ${JSON.stringify(paid)}`).toBe(true);
    if (!paid.ok) throw new Error('pay failed');

    const paidRow = await readRow(invoiceId);
    expect(paidRow!.status).toBe('paid');
    expect(paidRow!.receiptDocumentNumberRaw).toMatch(/^RC-2026-\d{6}$/);
    // pdf_doc_kind stays 'invoice' (the §86/4 receipt is a SEPARATE blob;
    // applyPayment does not change the column). The receipt KIND
    // (receipt_combined) is proven by the receipt PDF content below.
    expect(paidRow!.pdfDocKind).toBe('invoice');
    expect(paidRow!.receiptPdfStatus).toBe('rendered');
    // The pinned treatment survives to the paid row (immutable).
    expect(paidRow!.vatTreatment).toBe('zero_rated_80_1_5');
    expect(paidRow!.vatSatang?.toString()).toBe('0');

    // SC-008 — the §86/4 receipt PDF computes VAT 0% + carries the §80/1(5) note.
    expect(receiptBytes).toHaveLength(1);
    const receiptText = await extractPdfText(receiptBytes[0]!);
    expect(receiptText, 'receipt must cite §80/1(5)').toMatch(RX_8015);
    expect(receiptText, 'receipt must reference the MFA cert number').toContain('0404/1234');
    expect(receiptText, 'receipt VAT rate is 0.00%').toContain('0.00%');

    // The bill (ใบแจ้งหนี้) shows VAT 0% but NOT the §80/1(5) note (§86/4-only).
    expect(billBytes).toHaveLength(1);
    const billText = await extractPdfText(billBytes[0]!);
    expect(billText).toContain('0.00%');
    expect(billText, 'bill carries NO §80/1(5) note').not.toMatch(RX_8015);

    // `tax_receipt_issued` audit records the pinned treatment + cert (T060).
    const [taxReceiptRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'tax_receipt_issued' as never),
          eq(auditLog.requestId, `zr-pay-${invoiceId}`),
        ),
      );
    expect(taxReceiptRow).toBeDefined();
    const trp = taxReceiptRow!.payload as Record<string, unknown>;
    expect(trp.vat_treatment).toBe('zero_rated_80_1_5');
    expect(trp.zero_rate_cert_no).toBe(CERT_NO);
  }, 120_000);

  it('AS2 — a zero-rate issue with NO cert number is blocked (fail-closed)', async () => {
    const draft = await createEventInvoiceDraft(makeCreateEventInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zr-nc-draft-${regNoCert}`,
      eventRegistrationId: regNoCert,
      amountOverride: 1_200_000,
      buyer: TIN_BUYER,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${JSON.stringify(draft)}`).toBe(true);
    if (!draft.ok) throw new Error('draft failed');
    const invoiceId = draft.value.invoiceId;

    const bytes: Uint8Array[] = [];
    const issued = await issueInvoice(issueDeps(tenant.ctx.slug, bytes), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zr-nc-issue-${invoiceId}`,
      invoiceId,
      vatTreatment: 'zero_rated_80_1_5',
      // no cert
    });
    expect(issued.ok).toBe(false);
    if (issued.ok) throw new Error('expected reject');
    expect(issued.error.code).toBe('zero_rate_cert_required');
    // Fail-closed — nothing rendered/persisted; the row stays draft.
    expect(bytes).toHaveLength(0);
    const row = await readRow(invoiceId);
    expect(row!.status).toBe('draft');
    expect(row!.vatTreatment).toBe('standard'); // never flipped
  }, 90_000);

  it('AS4 — a membership invoice stays VAT 7% and REJECTS a zero-rate attempt', async () => {
    // (a) a normal membership issue stays VAT 7% (standard).
    const stdDraft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zr-mem-std-draft-${memberId}`,
      memberId,
      planId,
      planYear,
    });
    expect(stdDraft.ok, stdDraft.ok ? 'ok' : JSON.stringify(stdDraft)).toBe(true);
    if (!stdDraft.ok) throw new Error('draft failed');
    const stdBytes: Uint8Array[] = [];
    const stdIssued = await issueInvoice(issueDeps(tenant.ctx.slug, stdBytes), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zr-mem-std-issue-${stdDraft.value.invoiceId}`,
      invoiceId: stdDraft.value.invoiceId,
      // no vatTreatment → defaults to 'standard'
    });
    expect(stdIssued.ok, stdIssued.ok ? 'ok' : JSON.stringify(stdIssued)).toBe(true);
    if (!stdIssued.ok) throw new Error('std issue failed');
    const stdRow = await readRow(stdDraft.value.invoiceId);
    expect(stdRow!.vatTreatment).toBe('standard');
    // Membership STAYS VAT 7% (never coerced to 0%). The subtotal is pro-rated
    // by the membership pro-rate policy, so assert the 7% RELATIONSHIP, not a
    // fixed amount: vat = round-half-away(subtotal × 7%) AND vat > 0 (proves VAT
    // was applied — a zero-rate would be 0).
    expect(stdRow!.vatRateSnapshot).toBe('0.0700');
    const stdSub = Number(stdRow!.subtotalSatang);
    const stdVat = Number(stdRow!.vatSatang);
    expect(stdVat).toBeGreaterThan(0);
    expect(stdVat).toBe(Math.round((stdSub * 7) / 100));

    // (b) a membership zero-rate attempt is REJECTED (reject, not coerce).
    const zrDraft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zr-mem-zr-draft-${memberId}`,
      memberId,
      planId,
      planYear,
    });
    expect(zrDraft.ok).toBe(true);
    if (!zrDraft.ok) throw new Error('draft failed');
    const zrIssued = await issueInvoice(issueDeps(tenant.ctx.slug, []), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zr-mem-zr-issue-${zrDraft.value.invoiceId}`,
      invoiceId: zrDraft.value.invoiceId,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: CERT_NO,
    });
    expect(zrIssued.ok).toBe(false);
    if (zrIssued.ok) throw new Error('expected reject');
    expect(zrIssued.error.code).toBe('membership_cannot_be_zero_rated');
    const zrRow = await readRow(zrDraft.value.invoiceId);
    expect(zrRow!.status).toBe('draft');
    expect(zrRow!.vatTreatment).toBe('standard');
  }, 120_000);
});
