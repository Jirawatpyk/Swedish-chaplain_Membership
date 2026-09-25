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
 * For each month the CSV lists the same receipts as the register, plus each
 * §86/10 credit note issued that month as a negative row, so its VAT column
 * sums to the register's NET output VAT (`rcVat + reVat − creditNoteVat`, the
 * ภ.พ.30 figure).
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

/** Data rows split into cells. Test fixtures carry no commas in quoted fields. */
function csvRows(csv: string): string[][] {
  return csv
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n')
    .slice(1)
    .map((l) => l.split(','));
}

/** Column 14 ("Status") marks the §86/10 credit-note rows. */
const isCreditNoteRow = (cells: readonly string[]) => cells[13] === 'Credit note';

/** CSV column 8 ("VAT", baht with 2 decimals, credit notes negative) summed as satang. */
function csvVatSatang(csv: string): bigint {
  let sum = 0n;
  for (const cells of csvRows(csv)) {
    const vat = cells[7] ?? '';
    const negative = vat.startsWith('-');
    const [baht = '0', satang = '00'] = vat.replace(/^-/, '').split('.');
    const abs = BigInt(baht) * 100n + BigInt(satang.padEnd(2, '0'));
    sum += negative ? -abs : abs;
  }
  return sum;
}

/** Column 2 ("Invoice No.") of the invoice rows — the §87 number a combined-mode row carries. */
function csvInvoiceNumbers(csv: string): string[] {
  return csvRows(csv)
    .filter((c) => !isCreditNoteRow(c))
    .map((c) => c[1] ?? '')
    .sort();
}

/** Column 3 ("Receipt No.") of the invoice rows. */
function csvReceiptNumbers(csv: string): string[] {
  return csvRows(csv)
    .filter((c) => !isCreditNoteRow(c))
    .map((c) => c[2] ?? '')
    .sort();
}

/** Credit-note rows as `[number, VAT, reference document]`. */
function csvCreditNotes(csv: string): string[][] {
  return csvRows(csv)
    .filter(isCreditNoteRow)
    .map((c) => [c[1] ?? '', c[7] ?? '', c[14] ?? '']);
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
  // Combined-mode rows (the §87 INV number IS the §86/4 tax invoice; no
  // RC/RE) — issued before the tax-at-payment switch, or with the flag off.
  // Issued in APRIL, paid in MAY: a tax invoice issued before payment fixes
  // the tax point at its issue date (§78/1(1)(ก)), so they belong to April.
  const combinedPaid = randomUUID();
  const combinedCredited = randomUUID();
  const combinedVoid = randomUUID();
  const combinedUnpaid = randomUUID();

  function combinedReceipt(o: {
    invoiceId: string;
    sequenceNumber: number;
    issueDate: string;
    paymentDate: string;
  }) {
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
      issueDate: o.issueDate,
      dueDate: o.issueDate,
    };
  }

  /** An issued, not-yet-paid combined-mode INV — a tax invoice already. */
  function combinedIssuedUnpaid(o: { invoiceId: string; sequenceNumber: number; issueDate: string }) {
    return {
      tenantId: tenant.ctx.slug,
      invoiceId: o.invoiceId,
      invoiceSubject: 'membership' as const,
      memberId: MEMBER_ID,
      planYear: 2026,
      planId: 'parity-plan',
      draftByUserId: user.userId,
      status: 'issued' as const,
      fiscalYear: 2026,
      sequenceNumber: o.sequenceNumber,
      documentNumber: `INV-2026-${String(o.sequenceNumber).padStart(6, '0')}`,
      issueDate: o.issueDate,
      dueDate: '2026-05-30',
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
      pdfBlobKey: 'invoicing/parity/unpaid.pdf',
      pdfSha256: 'd'.repeat(64),
      pdfTemplateVersion: 8,
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
      // rc + re − credit notes: the net ภ.พ.30 output VAT.
      netVat: BigInt(rc.value.periodOutputVat.combinedVatSatang),
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
        combinedReceipt({
          invoiceId: combinedPaid,
          sequenceNumber: 501,
          issueDate: '2026-04-27',
          paymentDate: '2026-05-10',
        }),
        combinedReceipt({
          invoiceId: combinedCredited,
          sequenceNumber: 502,
          issueDate: '2026-04-28',
          paymentDate: '2026-05-12',
        }),
        combinedReceipt({
          invoiceId: combinedVoid,
          sequenceNumber: 503,
          issueDate: '2026-04-29',
          paymentDate: '2026-05-14',
        }),
        combinedIssuedUnpaid({ invoiceId: combinedUnpaid, sequenceNumber: 504, issueDate: '2026-04-30' }),
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
        {
          // Full credit of the combined-mode INV-502 (issued in April),
          // issued in May: it cites the INV and nets May's output VAT.
          tenantId: slug,
          creditNoteId: randomUUID(),
          originalInvoiceId: combinedCredited,
          fiscalYear: 2026,
          sequenceNumber: 3,
          documentNumber: 'CN-2026-000093',
          issueDate: '2026-05-20',
          issuedByUserId: user.userId,
          reason: 'combined credit',
          creditAmountSatang: 100_000n,
          vatSatang: 7_000n,
          totalSatang: 107_000n,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_MEMBER,
          pdfBlobKey: 'invoicing/parity/cn3.pdf',
          pdfSha256: 'd'.repeat(64),
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
    // 7,000 + 14,000 (back-dated) + 22,897 (§105) − 21,000 (CN-091, issued
    // 5 July against June's RC-091) satang.
    expect(csvCreditNotes(jul.csv)).toEqual([['CN-2026-000091', '-210.00', 'RC-2026-000091']]);
    expect(csvVatSatang(jul.csv)).toBe(22_897n);
    expect(csvVatSatang(jul.csv)).toBe(julRegister.netVat);

    const aug = await exportMonth('2026-08-01', '2026-08-31');
    const augRegister = await registerMonth('2026-08-01', '2026-08-31');
    expect(csvReceiptNumbers(aug.csv)).toEqual(['RC-2026-000103']);
    expect(csvReceiptNumbers(aug.csv)).toEqual(augRegister.receiptNumbers);
    expect(csvCreditNotes(aug.csv)).toEqual([]);
    expect(csvVatSatang(aug.csv)).toBe(9_100n);
    expect(csvVatSatang(aug.csv)).toBe(augRegister.netVat);
  });

  it('a receipt credited later stays in the export of the month it was paid, like the register', async () => {
    const jun = await exportMonth('2026-06-01', '2026-06-30');
    const junRegister = await registerMonth('2026-06-01', '2026-06-30');
    // Fully credited + partially credited are both exported; the void is not.
    expect(csvReceiptNumbers(jun.csv)).toEqual(['RC-2026-000091', 'RC-2026-000092']);
    expect(csvReceiptNumbers(jun.csv)).toEqual(junRegister.receiptNumbers);
    // The full credit (CN-091) is issued in July, so only CN-092 nets here:
    // 21,000 + 7,000 − 700 satang.
    expect(csvCreditNotes(jun.csv)).toEqual([['CN-2026-000092', '-7.00', 'RC-2026-000092']]);
    expect(csvVatSatang(jun.csv)).toBe(27_300n);
    expect(csvVatSatang(jun.csv)).toBe(junRegister.netVat);
  });

  it('combined-mode tax invoices are bucketed by issue date, and flag that month incomplete', async () => {
    // April — the issue month. Paid + credited export; the void and the
    // unpaid one do not (this is the paid-invoices CSV).
    const apr = await exportMonth('2026-04-01', '2026-04-30');
    expect(csvInvoiceNumbers(apr.csv)).toEqual(['INV-2026-000501', 'INV-2026-000502']);
    expect(csvVatSatang(apr.csv)).toBe(14_000n);

    // May — the payment month holds none of them.
    const may = await exportMonth('2026-05-01', '2026-05-31');
    expect(csvInvoiceNumbers(may.csv)).toEqual([]);
    // …but the credit note issued in May against INV-502 is there, citing
    // the INV, and nets May exactly like the register.
    expect(csvCreditNotes(may.csv)).toEqual([['CN-2026-000093', '-70.00', 'INV-2026-000502']]);
    expect(csvVatSatang(may.csv)).toBe(-7_000n);
    expect(csvVatSatang(may.csv)).toBe((await registerMonth('2026-05-01', '2026-05-31')).netVat);

    // The register lists only RC/RE, so April's figure is incomplete: the
    // three non-void combined INVs (unpaid one included — it is already a tax
    // invoice) are counted.
    const deps = makeListTaxDocumentRegisterDeps(tenant.ctx.slug);
    const aprRegister = await listTaxDocumentRegister(deps, {
      tenantId: tenant.ctx.slug,
      kind: 'rc_register',
      from: '2026-04-01',
      to: '2026-04-30',
    });
    if (!aprRegister.ok) throw new Error('register failed');
    expect(aprRegister.value.rows).toEqual([]);
    expect(aprRegister.value.legacyCombinedCount).toBe(3);
    expect(aprRegister.value.periodStatus).toBe('closed_month_incomplete');

    const mayRegister = await listTaxDocumentRegister(deps, {
      tenantId: tenant.ctx.slug,
      kind: 'rc_register',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    if (!mayRegister.ok) throw new Error('register failed');
    expect(mayRegister.value.legacyCombinedCount).toBe(0);
    expect(mayRegister.value.periodStatus).toBe('closed_month');
  });
});
