/**
 * Integration (live Neon) — the paid-invoices CSV export and the ภ.พ.30 tax
 * register bucket receipts identically.
 *
 * The export used to filter `status = 'paid'` and bucket by `paid_at`, while the
 * register buckets by the §78/1 tax point `COALESCE(payment_date, paid_at)`
 * across every non-void status. Two receipts therefore disagreed:
 *   - a BACK-DATED payment (payment_date in July, marked paid in August) landed
 *     in the August CSV but the July register;
 *   - a receipt CREDITED later (status → credited) vanished from the CSV of the
 *     month it was paid, while the register still counts it (its reduction is
 *     the §86/10 credit note, netted in the month the note is issued).
 *
 * For each month the CSV's VAT column must sum to the register's gross output
 * VAT (`rcVatSatang + reVatSatang`), and list the same receipts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import {
  exportPaidInvoicesCsv,
  listTaxDocumentRegister,
  makeListTaxDocumentRegisterDeps,
  type ExportPaidInvoicesCsvDeps,
} from '@/modules/invoicing';
import { makeDrizzleTaxRegisterRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
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
  legal_name: 'Parity Co',
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

const MEMBER_ID = '00000000-0000-4000-8000-0000000000d1';

/** CSV column 8 ("VAT", baht with 2 decimals) summed as satang. */
function csvVatSatang(csv: string): bigint {
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n').slice(1);
  let sum = 0n;
  for (const line of lines) {
    // Test fixtures carry no commas in quoted fields, so a plain split is safe.
    const vat = line.split(',')[7] ?? '';
    const [baht = '0', satang = '00'] = vat.split('.');
    sum += BigInt(baht) * 100n + BigInt(satang.padEnd(2, '0'));
  }
  return sum;
}

/** Column 2 ("Invoice No.") — the §87 number a combined-mode row carries. */
function csvInvoiceNumbers(csv: string): string[] {
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n').slice(1);
  return lines.map((l) => l.split(',')[1] ?? '').sort();
}

function csvReceiptNumbers(csv: string): string[] {
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n').slice(1);
  return lines.map((l) => l.split(',')[2] ?? '').sort();
}

describe('paid-invoices CSV export ↔ ภ.พ.30 register parity (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  // July: a normal receipt, a back-dated one (tax point July, marked paid in
  // August) and a §105 RE receipt. August: a receipt marked paid in July but
  // with an August tax point (the mirror case).
  const rcJul = randomUUID();
  const rcBackDated = randomUUID();
  const reJul = randomUUID();
  const rcAugTaxPoint = randomUUID();
  // June: a receipt fully credited by a §86/10 note issued in July, a receipt
  // partially credited, and a voided receipt (never in either total).
  const rcCredited = randomUUID();
  const rcPartial = randomUUID();
  const rcVoid = randomUUID();
  const eventId = randomUUID();
  const regRe = randomUUID();
  // May: combined-mode rows (the §87 INV number IS the receipt; no RC/RE) —
  // paid before the tax-at-payment switch, or with the flag off.
  const combinedPaid = randomUUID();
  const combinedCredited = randomUUID();
  const combinedVoid = randomUUID();

  function combinedReceipt(o: { invoiceId: string; sequenceNumber: number; paymentDate: string }) {
    return {
      ...paidReceipt({
        invoiceId: o.invoiceId,
        bill: 'unused',
        rc: 'unused',
        paymentDate: o.paymentDate,
        paidAt: `${o.paymentDate}T04:00:00Z`,
        subtotalSatang: 100_000n,
        vatSatang: 7_000n,
      }),
      billDocumentNumberRaw: null,
      receiptDocumentNumberRaw: null,
      sequenceNumber: o.sequenceNumber,
      documentNumber: `INV-2026-${String(o.sequenceNumber).padStart(6, '0')}`,
    };
  }

  function paidReceipt(o: {
    invoiceId: string;
    bill: string;
    rc: string;
    paymentDate: string;
    paidAt: string;
    subtotalSatang: bigint;
    vatSatang: bigint;
  }) {
    return {
      tenantId: tenant.ctx.slug,
      invoiceId: o.invoiceId,
      invoiceSubject: 'membership' as const,
      memberId: MEMBER_ID,
      planYear: 2026,
      planId: 'parity-plan',
      draftByUserId: user.userId,
      status: 'paid' as const,
      billDocumentNumberRaw: o.bill,
      receiptDocumentNumberRaw: o.rc,
      receiptPdfStatus: 'rendered' as const,
      paidAt: new Date(o.paidAt),
      paymentMethod: 'bank_transfer' as const,
      paymentDate: o.paymentDate,
      fiscalYear: 2026,
      issueDate: o.paymentDate,
      dueDate: o.paymentDate,
      subtotalSatang: o.subtotalSatang,
      vatRateSnapshot: '0.0700',
      vatSatang: o.vatSatang,
      totalSatang: o.subtotalSatang + o.vatSatang,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfDocKind: 'invoice' as const,
      pdfBlobKey: 'invoicing/parity/x.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 8,
    };
  }

  function exportDeps(): ExportPaidInvoicesCsvDeps {
    return {
      registerRepo: makeDrizzleTaxRegisterRepo(tenant.ctx.slug),
      audit: f4AuditAdapter,
      paymentMethodLookup: async () => new Map<string, 'card' | 'promptpay'>(),
    };
  }

  async function exportMonth(from: string, to: string) {
    const result = await exportPaidInvoicesCsv(exportDeps(), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-parity-${randomUUID()}`,
      from,
      to,
    });
    if (!result.ok) throw new Error(`export failed: ${result.error.code}`);
    return result.value;
  }

  async function registerMonth(from: string, to: string) {
    const deps = makeListTaxDocumentRegisterDeps(tenant.ctx.slug);
    const [rc, re] = await Promise.all([
      listTaxDocumentRegister(deps, { tenantId: tenant.ctx.slug, kind: 'rc_register', from, to }),
      listTaxDocumentRegister(deps, { tenantId: tenant.ctx.slug, kind: 're_register', from, to }),
    ]);
    if (!rc.ok || !re.ok) throw new Error('register failed');
    const live = [...rc.value.rows, ...re.value.rows].filter((r) => r.status !== 'void');
    return {
      grossVat:
        BigInt(rc.value.periodOutputVat.rcVatSatang) +
        BigInt(rc.value.periodOutputVat.reVatSatang),
      receiptNumbers: live.map((r) => r.receiptDocumentNumberRaw ?? '').sort(),
    };
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    const slug = tenant.ctx.slug;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: slug,
        planId: 'parity-plan',
        planYear: 2026,
        planName: { en: 'Parity Plan' },
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
      await tx.insert(members).values({
        tenantId: slug,
        memberId: MEMBER_ID,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Parity Co',
        country: 'TH',
        planId: 'parity-plan',
        planYear: 2026,
      });
      await tx.insert(events).values({
        tenantId: slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_parity',
        name: 'Parity Gala',
        startDate: new Date('2026-07-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values([
        {
          tenantId: slug,
          registrationId: regRe,
          eventId,
          externalId: 'att_parity_re',
          attendeeEmail: 'guest@example.com',
          attendeeName: 'Walk-in Guest',
          attendeeCompany: 'Walk-in Guest Ltd',
          matchType: 'non_member',
          ticketType: 'VIP',
          ticketPriceThb: 3500,
          paymentStatus: 'paid',
          registeredAt: new Date('2026-07-03T03:00:00Z'),
        },
      ] satisfies NewEventRegistrationRow[]);

      await tx.insert(invoices).values([
        paidReceipt({
          invoiceId: rcJul,
          bill: 'SC-2026-000101',
          rc: 'RC-2026-000101',
          paymentDate: '2026-07-10',
          paidAt: '2026-07-10T04:00:00Z',
          subtotalSatang: 100_000n,
          vatSatang: 7_000n,
        }),
        // Back-dated: tax point 31 July, marked paid on 2 August.
        paidReceipt({
          invoiceId: rcBackDated,
          bill: 'SC-2026-000102',
          rc: 'RC-2026-000102',
          paymentDate: '2026-07-31',
          paidAt: '2026-08-02T04:00:00Z',
          subtotalSatang: 200_000n,
          vatSatang: 14_000n,
        }),
        // Mirror: tax point 5 August, marked paid on 30 July.
        paidReceipt({
          invoiceId: rcAugTaxPoint,
          bill: 'SC-2026-000103',
          rc: 'RC-2026-000103',
          paymentDate: '2026-08-05',
          paidAt: '2026-07-30T04:00:00Z',
          subtotalSatang: 130_000n,
          vatSatang: 9_100n,
        }),
        paidReceipt({
          invoiceId: rcCredited,
          bill: 'SC-2026-000091',
          rc: 'RC-2026-000091',
          paymentDate: '2026-06-15',
          paidAt: '2026-06-15T04:00:00Z',
          subtotalSatang: 300_000n,
          vatSatang: 21_000n,
        }),
        paidReceipt({
          invoiceId: rcPartial,
          bill: 'SC-2026-000092',
          rc: 'RC-2026-000092',
          paymentDate: '2026-06-18',
          paidAt: '2026-06-18T04:00:00Z',
          subtotalSatang: 100_000n,
          vatSatang: 7_000n,
        }),
        paidReceipt({
          invoiceId: rcVoid,
          bill: 'SC-2026-000093',
          rc: 'RC-2026-000093',
          paymentDate: '2026-06-20',
          paidAt: '2026-06-20T04:00:00Z',
          subtotalSatang: 50_000n,
          vatSatang: 3_500n,
        }),
        combinedReceipt({ invoiceId: combinedPaid, sequenceNumber: 501, paymentDate: '2026-05-10' }),
        combinedReceipt({
          invoiceId: combinedCredited,
          sequenceNumber: 502,
          paymentDate: '2026-05-12',
        }),
        combinedReceipt({ invoiceId: combinedVoid, sequenceNumber: 503, paymentDate: '2026-05-14' }),
        // §105 RE receipt (event, no TIN) in July — real 7% output VAT.
        {
          tenantId: slug,
          invoiceId: reJul,
          invoiceSubject: 'event',
          eventId,
          eventRegistrationId: regRe,
          vatInclusive: true,
          memberId: null,
          planId: null,
          planYear: null,
          draftByUserId: user.userId,
          status: 'paid',
          receiptDocumentNumberRaw: 'RE-2026-000101',
          receiptPdfStatus: 'rendered',
          paidAt: new Date('2026-07-12T04:00:00Z'),
          paymentMethod: 'bank_transfer',
          paymentDate: '2026-07-12',
          fiscalYear: 2026,
          issueDate: '2026-07-12',
          dueDate: '2026-07-12',
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
          pdfBlobKey: 'invoicing/parity/re.pdf',
          pdfSha256: 'f'.repeat(64),
          pdfTemplateVersion: 8,
        },
      ]);

      await tx
        .update(invoices)
        .set({ status: 'credited', creditedTotalSatang: 107_000n })
        .where(and(eq(invoices.tenantId, slug), eq(invoices.invoiceId, combinedCredited)));
      await tx
        .update(invoices)
        .set({
          status: 'void',
          voidedAt: new Date('2026-05-14T05:00:00Z'),
          voidReason: 'test cancellation',
          voidedByUserId: user.userId,
        })
        .where(and(eq(invoices.tenantId, slug), eq(invoices.invoiceId, combinedVoid)));
      // Fully credited in July by a §86/10 note; partially credited in June.
      await tx
        .update(invoices)
        .set({ status: 'credited', creditedTotalSatang: 321_000n })
        .where(and(eq(invoices.tenantId, slug), eq(invoices.invoiceId, rcCredited)));
      await tx
        .update(invoices)
        .set({ status: 'partially_credited', creditedTotalSatang: 10_700n })
        .where(and(eq(invoices.tenantId, slug), eq(invoices.invoiceId, rcPartial)));
      await tx
        .update(invoices)
        .set({
          status: 'void',
          voidedAt: new Date('2026-06-20T05:00:00Z'),
          voidReason: 'test cancellation',
          voidedByUserId: user.userId,
        })
        .where(and(eq(invoices.tenantId, slug), eq(invoices.invoiceId, rcVoid)));
      await tx.insert(creditNotes).values([
        {
          tenantId: slug,
          creditNoteId: randomUUID(),
          originalInvoiceId: rcCredited,
          fiscalYear: 2026,
          sequenceNumber: 1,
          documentNumber: 'CN-2026-000091',
          issueDate: '2026-07-05',
          issuedByUserId: user.userId,
          reason: 'full credit',
          creditAmountSatang: 300_000n,
          vatSatang: 21_000n,
          totalSatang: 321_000n,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_MEMBER,
          pdfBlobKey: 'invoicing/parity/cn1.pdf',
          pdfSha256: 'c'.repeat(64),
          pdfTemplateVersion: 8,
        },
        {
          tenantId: slug,
          creditNoteId: randomUUID(),
          originalInvoiceId: rcPartial,
          fiscalYear: 2026,
          sequenceNumber: 2,
          documentNumber: 'CN-2026-000092',
          issueDate: '2026-06-25',
          issuedByUserId: user.userId,
          reason: 'partial credit',
          creditAmountSatang: 10_000n,
          vatSatang: 700n,
          totalSatang: 10_700n,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_MEMBER,
          pdfBlobKey: 'invoicing/parity/cn2.pdf',
          pdfSha256: 'b'.repeat(64),
          pdfTemplateVersion: 8,
        },
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('a back-dated payment is exported in the month of its tax point, like the register', async () => {
    const jul = await exportMonth('2026-07-01', '2026-07-31');
    const julRegister = await registerMonth('2026-07-01', '2026-07-31');
    expect(csvReceiptNumbers(jul.csv)).toEqual([
      'RC-2026-000101',
      'RC-2026-000102',
      'RE-2026-000101',
    ]);
    expect(csvReceiptNumbers(jul.csv)).toEqual(julRegister.receiptNumbers);
    // 7,000 + 14,000 (back-dated) + 22,897 (§105) satang.
    expect(csvVatSatang(jul.csv)).toBe(43_897n);
    expect(csvVatSatang(jul.csv)).toBe(julRegister.grossVat);

    const aug = await exportMonth('2026-08-01', '2026-08-31');
    const augRegister = await registerMonth('2026-08-01', '2026-08-31');
    expect(csvReceiptNumbers(aug.csv)).toEqual(['RC-2026-000103']);
    expect(csvReceiptNumbers(aug.csv)).toEqual(augRegister.receiptNumbers);
    expect(csvVatSatang(aug.csv)).toBe(9_100n);
    expect(csvVatSatang(aug.csv)).toBe(augRegister.grossVat);
  });

  it('a receipt credited later stays in the export of the month it was paid, like the register', async () => {
    const jun = await exportMonth('2026-06-01', '2026-06-30');
    const junRegister = await registerMonth('2026-06-01', '2026-06-30');
    // Fully credited + partially credited are both exported; the void is not.
    expect(csvReceiptNumbers(jun.csv)).toEqual(['RC-2026-000091', 'RC-2026-000092']);
    expect(csvReceiptNumbers(jun.csv)).toEqual(junRegister.receiptNumbers);
    expect(csvVatSatang(jun.csv)).toBe(28_000n);
    expect(csvVatSatang(jun.csv)).toBe(junRegister.grossVat);
  });

  it('combined-mode receipts still export, and the register flags the month as incomplete', async () => {
    const may = await exportMonth('2026-05-01', '2026-05-31');
    // Paid + credited export on their tax point; the void does not.
    expect(csvInvoiceNumbers(may.csv)).toEqual(['INV-2026-000501', 'INV-2026-000502']);
    expect(csvVatSatang(may.csv)).toBe(14_000n);

    // The register lists only RC/RE receipts, so none of the three appear and
    // its gross VAT is 0 — the month cannot be "the figure to report".
    const result = await listTaxDocumentRegister(
      makeListTaxDocumentRegisterDeps(tenant.ctx.slug),
      { tenantId: tenant.ctx.slug, kind: 'rc_register', from: '2026-05-01', to: '2026-05-31' },
    );
    if (!result.ok) throw new Error('register failed');
    expect(result.value.rows).toEqual([]);
    expect(result.value.periodOutputVat.rcVatSatang).toBe('0');
    expect(result.value.legacyCombinedCount).toBe(2);
    expect(result.value.periodStatus).toBe('closed_month_incomplete');
  });
});
