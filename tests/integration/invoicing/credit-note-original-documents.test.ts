/**
 * Integration (live Neon `dev`) — the credit-note list and detail reads return
 * the ORIGINAL RECEIPT and BILL numbers, not the §87 `document_number` alone.
 *
 * An 088 bill carries `document_number = NULL` (its §87 number is the payment-
 * time RC in `receipt_document_number_raw`), so the list's old
 * `invoices.document_number` projection showed "—" for every 088 credit note
 * while the credit-note PDF itself references the RC. Also pins the refund
 * flag the list uses for its "Refund" badge (`source_refund_id` set).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { payments, refunds } from '@/modules/payments/infrastructure/schema';
import {
  getCreditNote,
  listCreditNotes,
  makeGetCreditNoteDeps,
  makeListCreditNotesDeps,
} from '@/modules/invoicing';
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
const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Credit Refs Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

const MEMBER_ID = '00000000-0000-4000-8000-0000000000e1';

describe('credit-note original receipt / bill numbers (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  const billInvoiceId = randomUUID(); // 088: SC bill paid → RC receipt
  const legacyInvoiceId = randomUUID(); // pre-088 combined: INV is the receipt
  const legacySeparateInvoiceId = randomUUID(); // pre-088 separate: INV + own receipt no.
  const cnLegacySeparate = randomUUID();
  const cnManual = randomUUID();
  const cnRefund = randomUUID();
  const paymentId = randomUUID();
  const refundId = randomUUID();

  function paid(o: {
    invoiceId: string;
    bill: string | null;
    rc: string | null;
    sequenceNumber: number | null;
    documentNumber: string | null;
  }) {
    return {
      tenantId: tenant.ctx.slug,
      invoiceId: o.invoiceId,
      invoiceSubject: 'membership' as const,
      memberId: MEMBER_ID,
      planYear: 2026,
      planId: 'cnref-plan',
      draftByUserId: user.userId,
      status: 'partially_credited' as const,
      billDocumentNumberRaw: o.bill,
      receiptDocumentNumberRaw: o.rc,
      sequenceNumber: o.sequenceNumber,
      documentNumber: o.documentNumber,
      receiptPdfStatus: 'rendered' as const,
      paidAt: new Date('2026-09-12T04:00:00Z'),
      paymentMethod: 'bank_transfer' as const,
      paymentDate: '2026-09-12',
      fiscalYear: 2026,
      issueDate: '2026-09-01',
      dueDate: '2026-10-01',
      subtotalSatang: 3_600_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 252_000n,
      totalSatang: 3_852_000n,
      creditedTotalSatang: 1_070_000n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfDocKind: o.rc === null ? ('receipt_combined' as const) : ('invoice' as const),
      pdfBlobKey: 'invoicing/cnref/x.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 8,
    };
  }

  function creditNote(o: {
    creditNoteId: string;
    originalInvoiceId: string;
    sequenceNumber: number;
    sourceRefundId: string | null;
  }) {
    return {
      tenantId: tenant.ctx.slug,
      creditNoteId: o.creditNoteId,
      originalInvoiceId: o.originalInvoiceId,
      fiscalYear: 2026,
      sequenceNumber: o.sequenceNumber,
      documentNumber: `CN-2026-${String(o.sequenceNumber).padStart(6, '0')}`,
      issueDate: '2026-09-23',
      issuedByUserId: user.userId,
      reason: 'difference credited',
      creditAmountSatang: 1_000_000n,
      vatSatang: 70_000n,
      totalSatang: 1_070_000n,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: 'invoicing/cnref/cn.pdf',
      pdfSha256: 'c'.repeat(64),
      pdfTemplateVersion: 8,
      sourceRefundId: o.sourceRefundId,
    };
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    const slug = tenant.ctx.slug;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: slug,
        planId: 'cnref-plan',
        planYear: 2026,
        planName: { en: 'Credit Refs Plan' },
        description: { en: 'desc' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 3_600_000,
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
        tenantId: slug,
        memberId: MEMBER_ID,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Credit Refs Co',
        country: 'TH',
        planId: 'cnref-plan',
        planYear: 2026,
      });
      await tx.insert(invoices).values([
        paid({
          invoiceId: billInvoiceId,
          bill: 'SC-2026-000102',
          rc: 'RC-2026-000038',
          sequenceNumber: null,
          documentNumber: null,
        }),
        paid({
          invoiceId: legacyInvoiceId,
          bill: null,
          rc: null,
          sequenceNumber: 52,
          documentNumber: 'INV-2026-000052',
        }),
        paid({
          invoiceId: legacySeparateInvoiceId,
          bill: null,
          rc: 'RC-2026-000039',
          sequenceNumber: 53,
          documentNumber: 'INV-2026-000053',
        }),
      ]);
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: slug,
        invoiceId: legacyInvoiceId,
        memberId: MEMBER_ID,
        method: 'card',
        status: 'succeeded',
        amountSatang: 3_852_000n,
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID()}`,
        processorChargeId: `ch_test_${randomUUID()}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        cardBrand: 'visa',
        cardLast4: '4242',
        cardExpMonth: 12,
        cardExpYear: 2030,
        initiatedAt: new Date('2026-09-12T03:00:00Z'),
        completedAt: new Date('2026-09-12T03:00:10Z'),
        actorUserId: user.userId,
        correlationId: 'test-corr-payment',
      });
      await tx.insert(refunds).values({
        id: refundId,
        tenantId: slug,
        paymentId,
        invoiceId: legacyInvoiceId,
        amountSatang: asSatang(1_070_000n),
        reason: 'Customer requested refund',
        status: 'pending',
        initiatedAt: new Date('2026-09-23T03:00:00Z'),
        initiatorUserId: user.userId,
        correlationId: 'test-corr-refund',
      });
      await tx.insert(creditNotes).values([
        creditNote({
          creditNoteId: cnManual,
          originalInvoiceId: billInvoiceId,
          sequenceNumber: 14,
          sourceRefundId: null,
        }),
        creditNote({
          creditNoteId: cnRefund,
          originalInvoiceId: legacyInvoiceId,
          sequenceNumber: 15,
          sourceRefundId: refundId,
        }),
        creditNote({
          creditNoteId: cnLegacySeparate,
          originalInvoiceId: legacySeparateInvoiceId,
          sequenceNumber: 16,
          sourceRefundId: null,
        }),
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('the list returns the RC receipt + SC bill, and flags the refund-origin note', async () => {
    const result = await listCreditNotes(makeListCreditNotesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 25,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.rows.map((r) => [r.creditNoteId, r]));

    expect(byId.get(cnManual)?.original).toEqual({
      receiptNumberRaw: 'RC-2026-000038',
      related: { kind: 'bill', numberRaw: 'SC-2026-000102' },
    });
    expect(byId.get(cnManual)?.isRefund).toBe(false);

    expect(byId.get(cnRefund)?.original).toEqual({
      receiptNumberRaw: 'INV-2026-000052',
      related: { kind: 'combined' },
    });
    expect(byId.get(cnRefund)?.isRefund).toBe(true);

    // Legacy separate mode: the INV was the §86/4 tax invoice at issue — the
    // note cites it; the receipt number is the related document.
    expect(byId.get(cnLegacySeparate)?.original).toEqual({
      receiptNumberRaw: 'INV-2026-000053',
      related: { kind: 'receipt', numberRaw: 'RC-2026-000039' },
    });
  });

  it('the detail read returns the same original documents', async () => {
    const result = await getCreditNote(makeGetCreditNoteDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      creditNoteId: cnManual,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.originalDocuments).toEqual({
      receiptNumberRaw: 'RC-2026-000038',
      related: { kind: 'bill', numberRaw: 'SC-2026-000102' },
    });
  });
});
