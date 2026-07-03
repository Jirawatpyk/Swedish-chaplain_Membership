/**
 * Integration — 088 T065b: `listInvoicesPaged` document-type / tax-point /
 * vat-treatment filters (FR-031, ภพ.30 support). Locks the SQL translation of
 * the three new admin-list filters against live Neon.
 *
 * Data-model mapping under test (derived from invoices schema + as-paid
 * numbering streams — see the T065b report):
 *   - SC bill        → bill_document_number_raw IS NOT NULL AND
 *                      receipt_document_number_raw IS NULL          (unpaid 088 bill)
 *   - RC §86/4       → receipt_document_number_raw IS NOT NULL AND
 *                      receipt_document_number_raw NOT LIKE 'RE-%'  (§86/4 receipt)
 *   - RE §105        → receipt_document_number_raw LIKE 'RE-%'      (§105 receipt)
 *   - CN             → status IN ('credited','partially_credited')  (carries a CN)
 *   - tax-point pre  → SC predicate (bill awaiting payment)
 *   - tax-point at   → receipt_document_number_raw IS NOT NULL      (receipt issued)
 *   - vat_treatment  → invoices.vat_treatment = ?
 *
 * Six fixture rows exercise every predicate (membership rows are VAT-standard by
 * the `invoices_membership_is_standard` CHECK, so the zero-rate + RE rows are
 * EVENT-subject with real events + registrations to satisfy the composite FK).
 *
 * Lives in tests/integration/** → live Neon. Migrations 0231 (bill_document_
 * number_raw) + 0234 (vat_treatment) MUST be applied first (`pnpm db:migrate`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { listInvoicesPaged, makeListInvoicesDeps } from '@/modules/invoicing';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
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
  legal_name: 'Doc Filter Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};
const SNAP_BUYER = {
  legal_name: 'Walk-in Guest Ltd',
  tax_id: null,
  address: 'Bangkok',
  primary_contact_name: 'Guest',
  primary_contact_email: 'guest@example.com',
};
const SNAP_EMBASSY = {
  legal_name: 'Embassy of Testland',
  tax_id: '9999999999999',
  address: 'Bangkok',
  primary_contact_name: 'Attaché',
  primary_contact_email: 'embassy@example.com',
};

const MEMBER_ID = '00000000-0000-4000-8000-0000000000d1';

/** Shared non-draft membership skeleton (VAT-standard; PDF = invoice). */
function membershipBase(user: TestUser, tenantSlug: string) {
  return {
    tenantId: tenantSlug,
    invoiceSubject: 'membership' as const,
    memberId: MEMBER_ID,
    planYear: 2026,
    planId: 'reg-plan',
    draftByUserId: user.userId,
    fiscalYear: 2026,
    subtotalSatang: 100_000n,
    vatRateSnapshot: '0.0700',
    vatSatang: 7_000n,
    totalSatang: 107_000n,
    creditedTotalSatang: 0n,
    proRatePolicySnapshot: 'monthly',
    netDaysSnapshot: 30,
    tenantIdentitySnapshot: SNAP_TENANT,
    memberIdentitySnapshot: SNAP_MEMBER,
    pdfDocKind: 'invoice' as const,
    pdfBlobKey: 'invoicing/doc/x.pdf',
    pdfSha256: 'a'.repeat(64),
    pdfTemplateVersion: 8,
  };
}

describe('invoice listPaged — 088 document/tax-point/vat filters (T065b)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const scBill = randomUUID();
  const rcReceipt = randomUUID();
  const rcCredited = randomUUID();
  const reReceipt = randomUUID();
  const zeroRate = randomUUID();
  const legacyCtrl = randomUUID();
  const eventId = randomUUID();
  const regRe = randomUUID();
  const regZero = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    const slug = tenant.ctx.slug;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: slug,
        planId: 'reg-plan',
        planYear: 2026,
        planName: { en: 'Reg Plan' },
        description: { en: 'desc' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
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
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: SNAP_TENANT.legal_name_th,
        legalNameEn: SNAP_TENANT.legal_name_en,
        taxId: SNAP_TENANT.tax_id,
        registeredAddressTh: SNAP_TENANT.address_th,
        registeredAddressEn: SNAP_TENANT.address_en,
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(members).values({
        tenantId: slug,
        memberId: MEMBER_ID,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Doc Filter Co',
        country: 'TH',
        planId: 'reg-plan',
        planYear: 2026,
      });
      await tx.insert(events).values({
        tenantId: slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_doc_filter',
        name: 'Doc Filter Gala',
        startDate: new Date('2026-03-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values([
        {
          tenantId: slug,
          registrationId: regRe,
          eventId,
          externalId: 'att_re',
          attendeeEmail: 'guest@example.com',
          attendeeName: 'Walk-in Guest',
          attendeeCompany: 'Walk-in Guest Ltd',
          matchType: 'non_member',
          ticketType: 'VIP',
          ticketPriceThb: 3500,
          paymentStatus: 'paid',
          registeredAt: new Date('2026-03-01T03:00:00Z'),
        },
        {
          tenantId: slug,
          registrationId: regZero,
          eventId,
          externalId: 'att_zero',
          attendeeEmail: 'embassy@example.com',
          attendeeName: 'Embassy Rep',
          attendeeCompany: 'Embassy of Testland',
          matchType: 'non_member',
          ticketType: 'VIP',
          ticketPriceThb: 6000,
          paymentStatus: 'paid',
          registeredAt: new Date('2026-03-02T03:00:00Z'),
        },
      ] satisfies NewEventRegistrationRow[]);

      await tx.insert(invoices).values([
        // F1 — SC bill (unpaid 088 bill).
        {
          ...membershipBase(user, slug),
          invoiceId: scBill,
          status: 'issued',
          billDocumentNumberRaw: 'SC-2026-000001',
          issueDate: '2026-03-01',
          dueDate: '2026-04-01',
        },
        // F2 — RC §86/4 tax receipt (paid 088 membership bill).
        {
          ...membershipBase(user, slug),
          invoiceId: rcReceipt,
          status: 'paid',
          billDocumentNumberRaw: 'SC-2026-000002',
          receiptDocumentNumberRaw: 'RC-2026-000001',
          receiptPdfStatus: 'rendered',
          paidAt: new Date('2026-03-15T04:00:00Z'),
          paymentMethod: 'bank_transfer',
          paymentDate: '2026-03-15',
          issueDate: '2026-03-02',
          dueDate: '2026-04-02',
        },
        // F3 — RC receipt that was later CREDITED (carries a credit note).
        {
          ...membershipBase(user, slug),
          invoiceId: rcCredited,
          status: 'credited',
          creditedTotalSatang: 107_000n,
          billDocumentNumberRaw: 'SC-2026-000003',
          receiptDocumentNumberRaw: 'RC-2026-000002',
          receiptPdfStatus: 'rendered',
          paidAt: new Date('2026-03-16T04:00:00Z'),
          paymentDate: '2026-03-16',
          issueDate: '2026-03-03',
          dueDate: '2026-04-03',
        },
        // F4 — RE §105 receipt (event, no-TIN, paid).
        {
          tenantId: slug,
          invoiceId: reReceipt,
          invoiceSubject: 'event',
          eventId,
          eventRegistrationId: regRe,
          vatInclusive: true,
          memberId: null,
          planId: null,
          planYear: null,
          draftByUserId: user.userId,
          status: 'paid',
          receiptDocumentNumberRaw: 'RE-2026-000001',
          receiptPdfStatus: 'rendered',
          paidAt: new Date('2026-03-10T04:00:00Z'),
          paymentMethod: 'bank_transfer',
          paymentDate: '2026-03-10',
          fiscalYear: 2026,
          issueDate: '2026-03-10',
          dueDate: '2026-03-10',
          subtotalSatang: 327_103n,
          vatRateSnapshot: '0.0700',
          vatSatang: 22_897n,
          totalSatang: 350_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: null,
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_BUYER,
          pdfDocKind: 'receipt_separate',
          pdfBlobKey: 'invoicing/doc/re.pdf',
          pdfSha256: 'b'.repeat(64),
          pdfTemplateVersion: 8,
        },
        // F5 — zero-rate §80/1(5) RC (event, embassy buyer, paid).
        {
          tenantId: slug,
          invoiceId: zeroRate,
          invoiceSubject: 'event',
          eventId,
          eventRegistrationId: regZero,
          vatInclusive: false,
          memberId: null,
          planId: null,
          planYear: null,
          draftByUserId: user.userId,
          status: 'paid',
          receiptDocumentNumberRaw: 'RC-2026-000003',
          receiptPdfStatus: 'rendered',
          paidAt: new Date('2026-03-20T04:00:00Z'),
          paymentMethod: 'bank_transfer',
          paymentDate: '2026-03-20',
          fiscalYear: 2026,
          issueDate: '2026-03-20',
          dueDate: '2026-03-20',
          subtotalSatang: 600_000n,
          vatRateSnapshot: '0.0000',
          vatSatang: 0n,
          totalSatang: 600_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: null,
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_EMBASSY,
          pdfDocKind: 'receipt_combined',
          pdfBlobKey: 'invoicing/doc/zero.pdf',
          pdfSha256: 'c'.repeat(64),
          pdfTemplateVersion: 8,
          vatTreatment: 'zero_rated_80_1_5',
          zeroRateCertNo: 'MFA-2026-001',
          zeroRateCertDate: '2026-03-01',
        },
        // F6 — legacy §87 invoice-stream control (matches none of SC/RC/RE).
        {
          ...membershipBase(user, slug),
          invoiceId: legacyCtrl,
          status: 'issued',
          sequenceNumber: 1,
          documentNumber: 'INV-2026-000001',
          issueDate: '2026-03-05',
          dueDate: '2026-04-05',
        },
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function idsFor(
    opts: Partial<Parameters<typeof listInvoicesPaged>[1]>,
  ): Promise<string[]> {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      ...opts,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return [];
    return result.value.rows.map((r) => r.invoiceId).sort();
  }

  it('documentType=sc → only the unpaid 088 bill', async () => {
    expect(await idsFor({ documentType: 'sc' })).toEqual([scBill].sort());
  });

  it('documentType=rc → §86/4 receipts (incl. later-credited + zero-rate), excl. RE', async () => {
    expect(await idsFor({ documentType: 'rc' })).toEqual(
      [rcReceipt, rcCredited, zeroRate].sort(),
    );
  });

  it('documentType=re → only the §105 RE receipt', async () => {
    expect(await idsFor({ documentType: 're' })).toEqual([reReceipt].sort());
  });

  it('documentType=cn → invoices carrying a credit note (credited/partially)', async () => {
    expect(await idsFor({ documentType: 'cn' })).toEqual([rcCredited].sort());
  });

  it('taxPointState=pre_payment → the bill awaiting payment', async () => {
    expect(await idsFor({ taxPointState: 'pre_payment' })).toEqual([scBill].sort());
  });

  it('taxPointState=at_payment → every row with a receipt issued', async () => {
    expect(await idsFor({ taxPointState: 'at_payment' })).toEqual(
      [rcReceipt, rcCredited, reReceipt, zeroRate].sort(),
    );
  });

  it('vatTreatment=zero_rated_80_1_5 → only the §80/1(5) row', async () => {
    expect(await idsFor({ vatTreatment: 'zero_rated_80_1_5' })).toEqual(
      [zeroRate].sort(),
    );
  });

  it('vatTreatment=standard → every non-zero-rate row', async () => {
    expect(await idsFor({ vatTreatment: 'standard' })).toEqual(
      [scBill, rcReceipt, rcCredited, reReceipt, legacyCtrl].sort(),
    );
  });

  // 088 T069 / FR-030 — an issued ใบแจ้งหนี้ bill carries its number in
  // bill_document_number_raw (document_number NULL until payment); it MUST be
  // findable by that printed SC number, not only §87/§105 receipt numbers.
  it('search by the SC bill number → finds the issued 088 bill (FR-030 find gap)', async () => {
    expect(await idsFor({ search: 'SC-2026-000001' })).toEqual([scBill].sort());
  });

  it('search still finds a legacy §87 invoice by its document_number (unbroken)', async () => {
    expect(await idsFor({ search: 'INV-2026-000001' })).toEqual([legacyCtrl].sort());
  });

  it('search finds a receipt by its RC number (unbroken)', async () => {
    expect(await idsFor({ search: 'RC-2026-000003' })).toEqual([zeroRate].sort());
  });
});
