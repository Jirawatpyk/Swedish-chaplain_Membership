/**
 * Pure row builders for `scripts/seed-e2e-portal-invoices.ts` — the e2e member's
 * three invoices. Kept free of DB / blob / PDF I/O so the row shapes are
 * unit-tested (`tests/unit/scripts/e2e-portal-invoice-seeds.test.ts`).
 *
 * The paid fixtures SC-2026-900001/2 are REAL 088 paid bills — the shape
 * `issueInvoice` + `recordPayment` write with FEATURE_088_TAX_AT_PAYMENT on:
 * the SC number rides `bill_document_number_raw` (the §87 pair stays NULL), the
 * §86/4 RC tax receipt number rides `receipt_document_number_raw`, the main blob
 * is the bill (`pdf_doc_kind 'invoice'`) and the receipt blob is rendered.
 * They used to be seeded in the legacy pre-088 combined-mode shape (§87 number
 * in `document_number`, no RC, receipt `pending` forever), which production no
 * longer has (prod query 2026-09-28: 0 of 99 receipt-bearing invoices).
 *
 * The ISSUED pay-sheet fixture SC-2026-900003 is an unpaid 088 bill (SC number
 * in `bill_document_number_raw`, no §87 number): with the flag on, paying a
 * legacy §87-numbered invoice is refused (`legacy_invoice_needs_reissue`), so
 * the pay specs need a real bill. Paying it mints a frozen RC, so it is reset by
 * re-creating the row (`scripts/lib/e2e-issued-fixture-reset.ts`).
 */
import type { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';

type InvoiceInsert = typeof invoices.$inferInsert;

export interface E2ePortalInvoiceSeed {
  /** The SC bill number (`bill_document_number_raw`). */
  readonly number: string;
  readonly status: 'paid' | 'issued';
  readonly totalSatang: bigint;
  /** 6-digit sequence in the reserved 900000 fixture block. */
  readonly sequence: number;
  /**
   * Pinned so `E2E_ISSUED_INVOICE_ID` / `E2E_PAID_ONLINE_INVOICE_ID` stay valid
   * across re-seeds (random ids left the env pointing at deleted rows — #434,
   * #459).
   */
  readonly invoiceId: string;
}

// The 900000 block keeps fixtures clear of the real allocators, which start at
// 000001; seeds never touch tenant_document_sequences.
export const E2E_PORTAL_INVOICE_SEEDS: readonly E2ePortalInvoiceSeed[] = [
  {
    number: 'SC-2026-900001',
    status: 'paid',
    totalSatang: 1_070_000n,
    sequence: 900001,
    invoiceId: '00000000-e2e0-4fff-9ffe-000000900001',
  },
  {
    number: 'SC-2026-900002',
    status: 'paid',
    totalSatang: 2_140_000n,
    sequence: 900002,
    invoiceId: '00000000-e2e0-4fff-9ffe-000000900002',
  },
  {
    number: 'SC-2026-900003',
    status: 'issued',
    totalSatang: 535_000n,
    sequence: 900003,
    invoiceId: '00000000-e2e0-4fff-9ffe-000000900003',
  },
];

export const E2E_SEED_FISCAL_YEAR = 2026;
export const E2E_SEED_ISSUE_DATE = '2026-04-15';
export const E2E_SEED_DUE_DATE = '2026-05-15';
/** Receipt date of the paid fixtures (088 D7: the receipt is dated at payment). */
export const E2E_SEED_PAYMENT_DATE = '2026-04-18';

/**
 * Template version every fixture is rendered at. Mirrors
 * `CURRENT_TEMPLATE_VERSION` (template-registry.ts) at the time of writing; a
 * fixed value keeps the seeded bytes stable when the registry moves on.
 */
export const E2E_PAID_TEMPLATE_VERSION = 12;

export const E2E_TENANT_SNAPSHOT = {
  legal_name_en: 'Thai-Swedish Chamber of Commerce',
  legal_name_th: 'หอการค้าไทย-สวีเดน',
  tax_id: '0000000000000',
  address: 'Bangkok',
};

export const E2E_MEMBER_SNAPSHOT = {
  company_name: 'E2E Alpha Co',
  // 0045 `invoices_snapshot_has_contact_email` — non-draft snapshots must
  // carry string `legal_name` + `address` + the primary contact.
  legal_name: 'E2E Alpha Co',
  tax_id: null,
  address: 'Bangkok (E2E fixture)',
  primary_contact_email: 'e2e-member@swecham.test',
  primary_contact_name: 'E2E Alpha',
};

/** The §86/4 RC receipt number minted for a paid fixture (RC-2026-900001 …). */
export function receiptNumberFor(seed: E2ePortalInvoiceSeed): string {
  return seed.number.replace(/^SC-/, 'RC-');
}

/** Main (bill) blob key — the production scheme (`issue-invoice.ts`). */
export function mainPdfBlobKey(tenantSlug: string, seed: E2ePortalInvoiceSeed): string {
  return `invoicing/${tenantSlug}/${E2E_SEED_FISCAL_YEAR}/${seed.invoiceId}_v${E2E_PAID_TEMPLATE_VERSION}.pdf`;
}

/** Receipt blob key — the production scheme (`record-payment.ts`). */
export function receiptPdfBlobKey(tenantSlug: string, seed: E2ePortalInvoiceSeed): string {
  return `invoicing/${tenantSlug}/${E2E_SEED_FISCAL_YEAR}/${seed.invoiceId}_receipt_v${E2E_PAID_TEMPLATE_VERSION}.pdf`;
}

/** VAT-exclusive 7% split, exact in satang (subtotal + VAT = total). */
export function splitVat(totalSatang: bigint): { subtotalSatang: bigint; vatSatang: bigint } {
  const subtotalSatang = (totalSatang * 100n) / 107n;
  return { subtotalSatang, vatSatang: totalSatang - subtotalSatang };
}

export interface SeedPdf {
  readonly blobKey: string;
  readonly sha256: string;
}

export interface BuildE2ePortalInvoiceRowInput {
  readonly seed: E2ePortalInvoiceSeed;
  readonly tenantSlug: string;
  readonly memberId: string;
  readonly adminUserId: string;
  readonly mainPdf: SeedPdf;
  /** Required for a paid fixture (its receipt is rendered), null otherwise. */
  readonly receiptPdf: SeedPdf | null;
}

export function buildE2ePortalInvoiceRow(input: BuildE2ePortalInvoiceRowInput): InvoiceInsert {
  const { seed } = input;
  const { subtotalSatang, vatSatang } = splitVat(seed.totalSatang);
  const templateVersion = E2E_PAID_TEMPLATE_VERSION;
  const common = {
    tenantId: input.tenantSlug,
    invoiceId: seed.invoiceId,
    memberId: input.memberId,
    planYear: 2026,
    planId: 'regular',
    draftByUserId: input.adminUserId,
    status: seed.status,
    pdfDocKind: 'invoice',
    fiscalYear: E2E_SEED_FISCAL_YEAR,
    issueDate: E2E_SEED_ISSUE_DATE,
    dueDate: E2E_SEED_DUE_DATE,
    subtotalSatang,
    vatRateSnapshot: '0.0700',
    vatSatang,
    totalSatang: seed.totalSatang,
    proRatePolicySnapshot: 'none',
    netDaysSnapshot: 30,
    tenantIdentitySnapshot: E2E_TENANT_SNAPSHOT,
    memberIdentitySnapshot: E2E_MEMBER_SNAPSHOT,
    pdfBlobKey: input.mainPdf.blobKey,
    pdfSha256: input.mainPdf.sha256,
    pdfTemplateVersion: templateVersion,
    // 088 bill leg of `invoices_non_draft_has_snapshots`: bill raw set, §87 pair NULL.
    sequenceNumber: null,
    documentNumber: null,
    billDocumentNumberRaw: seed.number,
  } satisfies InvoiceInsert;

  if (seed.status === 'issued') {
    return {
      ...common,
      receiptDocumentNumberRaw: null,
      paidAt: null,
      paymentMethod: null,
      receiptPdfStatus: null,
    };
  }

  if (input.receiptPdf === null) {
    throw new Error(`e2e seed: paid fixture ${seed.number} needs its rendered receipt PDF`);
  }
  return {
    ...common,
    receiptDocumentNumberRaw: receiptNumberFor(seed),
    // `invoices_paid_has_payment` + the fields `applyPayment` writes.
    paidAt: new Date(`${E2E_SEED_PAYMENT_DATE}T03:00:00Z`),
    paymentMethod: 'bank_transfer',
    paymentDate: E2E_SEED_PAYMENT_DATE,
    paymentRecordedByUserId: input.adminUserId,
    // `invoices_paid_has_receipt_status` — rendered, with its blob, exactly as
    // the synchronous record-payment path leaves it.
    receiptPdfStatus: 'rendered',
    receiptPdfBlobKey: input.receiptPdf.blobKey,
    receiptPdfSha256: input.receiptPdf.sha256,
    receiptPdfTemplateVersion: templateVersion,
  };
}

/**
 * A fixture still in the legacy pre-088 shape (§87 number, no bill number) —
 * paid or issued, the seed replaces it with the 088 shape.
 */
export function isLegacyFixtureRow(row: {
  readonly documentNumber: string | null;
  readonly billDocumentNumberRaw: string | null;
}): boolean {
  return row.documentNumber !== null && row.billDocumentNumberRaw === null;
}
