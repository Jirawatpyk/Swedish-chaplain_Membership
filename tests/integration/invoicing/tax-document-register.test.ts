/**
 * Integration — 088 T065b: `listTaxDocumentRegister` (FR-031, ภพ.30 support).
 *
 * Two period-scoped registers for the monthly ภพ.30 (VAT return) filing:
 *   - `rc_register`     — the §86/4 RC tax receipts issued AT PAYMENT in the
 *                         period (output-VAT register). Bucketed by PAYMENT date
 *                         (`paid_at`, Bangkok-local) per the schema comment at
 *                         schema-invoices.ts:100-109 — NEVER by the bill/issue
 *                         `fiscal_year` column. Excludes §105 RE receipts.
 *   - `zero_rate_sales` — the §80/1(5) zero-rate RC receipts in the period.
 *
 * Rows are ordered by `receipt_document_number_raw` ASC (§87 sequential order).
 *
 * Lives in tests/integration/** → live Neon. Migrations 0231 + 0234 applied.
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
import {
  listTaxDocumentRegister,
  makeListTaxDocumentRegisterDeps,
} from '@/modules/invoicing';
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
  legal_name: 'Register Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};
const SNAP_EMBASSY = {
  legal_name: 'Embassy of Testland',
  tax_id: '9999999999999',
  address: 'Bangkok',
  primary_contact_name: 'Attaché',
  primary_contact_email: 'embassy@example.com',
};
const SNAP_BUYER = {
  legal_name: 'Walk-in Guest Ltd',
  tax_id: null,
  address: 'Bangkok',
  primary_contact_name: 'Guest',
  primary_contact_email: 'guest@example.com',
};

const MEMBER_ID = '00000000-0000-4000-8000-0000000000c1';

function membershipPaid(
  user: TestUser,
  slug: string,
  o: { invoiceId: string; bill: string; rc: string; paidAt: string; issueDate: string },
) {
  return {
    tenantId: slug,
    invoiceId: o.invoiceId,
    invoiceSubject: 'membership' as const,
    memberId: MEMBER_ID,
    planYear: 2026,
    planId: 'reg-plan',
    draftByUserId: user.userId,
    status: 'paid' as const,
    billDocumentNumberRaw: o.bill,
    receiptDocumentNumberRaw: o.rc,
    receiptPdfStatus: 'rendered' as const,
    paidAt: new Date(o.paidAt),
    paymentMethod: 'bank_transfer' as const,
    paymentDate: o.paidAt.slice(0, 10),
    fiscalYear: 2026,
    issueDate: o.issueDate,
    dueDate: o.issueDate,
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
    pdfBlobKey: 'invoicing/reg/x.pdf',
    pdfSha256: 'a'.repeat(64),
    pdfTemplateVersion: 8,
  };
}

describe('listTaxDocumentRegister — RC register + zero-rate sales (T065b)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const rc1 = randomUUID(); // in-period RC
  const rc2 = randomUUID(); // in-period RC
  const rcZero = randomUUID(); // in-period zero-rate RC (event)
  const rcRe = randomUUID(); // in-period RE (§105 — excluded from RC register)
  const rcOut = randomUUID(); // out-of-period RC
  const scUnpaid = randomUUID(); // unpaid bill (no receipt/paid_at — excluded)
  const eventId = randomUUID();
  const regZero = randomUUID();
  const regRe = randomUUID();

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
        companyName: 'Register Co',
        country: 'TH',
        planId: 'reg-plan',
        planYear: 2026,
      });
      await tx.insert(events).values({
        tenantId: slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_register',
        name: 'Register Gala',
        startDate: new Date('2026-03-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values([
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
          registeredAt: new Date('2026-03-03T03:00:00Z'),
        },
      ] satisfies NewEventRegistrationRow[]);

      await tx.insert(invoices).values([
        membershipPaid(user, slug, {
          invoiceId: rc1,
          bill: 'SC-2026-000001',
          rc: 'RC-2026-000001',
          paidAt: '2026-03-15T04:00:00Z',
          issueDate: '2026-03-01',
        }),
        membershipPaid(user, slug, {
          invoiceId: rc2,
          bill: 'SC-2026-000002',
          rc: 'RC-2026-000002',
          paidAt: '2026-03-20T04:00:00Z',
          issueDate: '2026-03-02',
        }),
        // out-of-period RC (paid in February).
        membershipPaid(user, slug, {
          invoiceId: rcOut,
          bill: 'SC-2026-000003',
          rc: 'RC-2026-000009',
          paidAt: '2026-02-15T04:00:00Z',
          issueDate: '2026-02-10',
        }),
        // unpaid bill (no receipt / paid_at).
        {
          tenantId: slug,
          invoiceId: scUnpaid,
          invoiceSubject: 'membership',
          memberId: MEMBER_ID,
          planYear: 2026,
          planId: 'reg-plan',
          draftByUserId: user.userId,
          status: 'issued',
          billDocumentNumberRaw: 'SC-2026-000004',
          fiscalYear: 2026,
          issueDate: '2026-03-05',
          dueDate: '2026-04-05',
          subtotalSatang: 100_000n,
          vatRateSnapshot: '0.0700',
          vatSatang: 7_000n,
          totalSatang: 107_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: 'monthly',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_MEMBER,
          pdfDocKind: 'invoice',
          pdfBlobKey: 'invoicing/reg/sc.pdf',
          pdfSha256: 'd'.repeat(64),
          pdfTemplateVersion: 8,
        },
        // zero-rate §80/1(5) RC (event, in-period).
        {
          tenantId: slug,
          invoiceId: rcZero,
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
          paidAt: new Date('2026-03-25T04:00:00Z'),
          paymentMethod: 'bank_transfer',
          paymentDate: '2026-03-25',
          fiscalYear: 2026,
          issueDate: '2026-03-25',
          dueDate: '2026-03-25',
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
          pdfBlobKey: 'invoicing/reg/zero.pdf',
          pdfSha256: 'e'.repeat(64),
          pdfTemplateVersion: 8,
          vatTreatment: 'zero_rated_80_1_5',
          zeroRateCertNo: 'MFA-2026-001',
          zeroRateCertDate: '2026-03-01',
        },
        // §105 RE receipt (event, in-period) — EXCLUDED from the RC register.
        {
          tenantId: slug,
          invoiceId: rcRe,
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
          paidAt: new Date('2026-03-12T04:00:00Z'),
          paymentMethod: 'bank_transfer',
          paymentDate: '2026-03-12',
          fiscalYear: 2026,
          issueDate: '2026-03-12',
          dueDate: '2026-03-12',
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
          pdfBlobKey: 'invoicing/reg/re.pdf',
          pdfSha256: 'f'.repeat(64),
          pdfTemplateVersion: 8,
        },
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('rc_register returns in-period §86/4 receipts in sequence order, excl. RE + out-of-period + unpaid', async () => {
    const result = await listTaxDocumentRegister(
      makeListTaxDocumentRegisterDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        kind: 'rc_register',
        from: '2026-03-01',
        to: '2026-03-31',
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Ordered by receipt number ASC → RC-…001, RC-…002, RC-…003.
    expect(result.value.rows.map((r) => r.invoiceId)).toEqual([rc1, rc2, rcZero]);
    // Regression (B2 review FINDING 1): the §86/4 RC register MUST still
    // exclude the §105 'RE' stream — those carry their own §87 register.
    expect(result.value.rows.map((r) => r.invoiceId)).not.toContain(rcRe);
    expect(result.value.summary.rowCount).toBe(3);
    // subtotal: 100000 + 100000 + 600000 = 800000 satang.
    expect(result.value.summary.totalSubtotalSatang).toBe('800000');
    // vat: 7000 + 7000 + 0 = 14000 satang.
    expect(result.value.summary.totalVatSatang).toBe('14000');
  });

  it('re_register returns only the §105 RE receipt in the period, excl. RC + zero-rate + out-of-period', async () => {
    const result = await listTaxDocumentRegister(
      makeListTaxDocumentRegisterDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        kind: 're_register',
        from: '2026-03-01',
        to: '2026-03-31',
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the §105 'RE' receipt; the §86/4 RC + zero-rate rows live in the
    // rc_register, and rcOut is out of period.
    expect(result.value.rows.map((r) => r.invoiceId)).toEqual([rcRe]);
    expect(result.value.summary.rowCount).toBe(1);
    // §105 RE receipts carry REAL 7% output VAT (splitVatInclusive) — 22897
    // satang here — which is exactly why they must be surfaced for ภ.พ.30.
    expect(result.value.summary.totalVatSatang).toBe('22897');
  });

  it('periodOutputVat combines §86/4 (RC) + §105 (RE) output VAT, independent of the selected kind', async () => {
    // FINDING 1: the ภ.พ.30 period output VAT figure must be CORRECT and
    // OBTAINABLE regardless of which register the accountant is viewing.
    for (const kind of ['rc_register', 'zero_rate_sales', 're_register'] as const) {
      const result = await listTaxDocumentRegister(
        makeListTaxDocumentRegisterDeps(tenant.ctx.slug),
        { tenantId: tenant.ctx.slug, kind, from: '2026-03-01', to: '2026-03-31' },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // RC-stream output VAT: 7000 + 7000 + 0 (zero-rate) = 14000.
      expect(result.value.periodOutputVat.rcVatSatang).toBe('14000');
      // §105 RE-stream output VAT: 22897.
      expect(result.value.periodOutputVat.reVatSatang).toBe('22897');
      // ภ.พ.30 output VAT = RC + RE = 36897. Summing VAT (not sales) means the
      // zero-rate §80/1(5) row contributes 0 — no explicit exclusion needed.
      expect(result.value.periodOutputVat.combinedVatSatang).toBe('36897');
    }
  });

  it('zero_rate_sales returns only the §80/1(5) receipt in the period', async () => {
    const result = await listTaxDocumentRegister(
      makeListTaxDocumentRegisterDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        kind: 'zero_rate_sales',
        from: '2026-03-01',
        to: '2026-03-31',
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.invoiceId)).toEqual([rcZero]);
    expect(result.value.summary.rowCount).toBe(1);
    expect(result.value.summary.totalVatSatang).toBe('0');
  });

  it('rejects an inverted range', async () => {
    const result = await listTaxDocumentRegister(
      makeListTaxDocumentRegisterDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        kind: 'rc_register',
        from: '2026-03-31',
        to: '2026-03-01',
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_range');
  });
});
