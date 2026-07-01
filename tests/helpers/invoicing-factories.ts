/**
 * 088-invoice-tax-flow-redesign (T002) — tax-flow invoice test builders.
 *
 * Three `invoices`-row-shaped fixture factories for the new bill → §86/4
 * tax-receipt-at-payment flow. They produce plain, overridable seed objects
 * that a story test spreads into `tx.insert(invoices).values({...seed})`
 * (adding the tenant + FK identity columns the specific test needs).
 *
 * Self-contained by design: this file does NOT import the Drizzle
 * `$inferInsert` row type. `bill_document_number_raw` (migration 0231) and
 * `vat_treatment` / `zero_rate_cert_*` (migration 0234, US8) land across the
 * feature's phases, so binding the seed to the live insert type would couple
 * this Phase-1 setup helper to not-yet-applied schema. Instead it exposes an
 * explicit `TaxFlowInvoiceSeed` shape covering exactly the tax-flow columns;
 * consuming tests keep the full type safety at their `.values(...)` boundary.
 *
 * Semantics the builders encode (data-model § A / § D / § F.8):
 *   - a BILL (ใบแจ้งหนี้) is `status='issued'`, `pdf_doc_kind='invoice'`, a
 *     NON-§87 `bill_document_number_raw` (SC), and NULL `sequence_number` /
 *     `document_number` (it is disjoint from the §87 uniqueness index, SC-003);
 *   - a TAX RECEIPT (ใบกำกับภาษี/ใบเสร็จรับเงิน) is the SAME row after payment:
 *     `status='paid'`, `pdf_doc_kind='receipt_combined'`, still carrying its
 *     bill number PLUS the §87 `receipt_document_number_raw` (RC) minted at the
 *     payment date;
 *   - a ZERO-RATE bill is a non-membership bill with
 *     `vat_treatment='zero_rated_80_1_5'`, VAT 0, and a captured MFA
 *     certificate (fail-closed — `zero_rate_cert_no` required).
 */

/** Bare satang money as stored on the `invoices` row (bigint columns). */
export type Satang = bigint;

/** §86/4 document class persisted on `invoices.pdf_doc_kind`. */
export type PdfDocKind = 'invoice' | 'receipt_combined' | 'receipt_separate';

/** Per-invoice VAT treatment (088 US8; column lands in migration 0234). */
export type VatTreatment = 'standard' | 'zero_rated_80_1_5';

/**
 * The tax-flow-relevant subset of an `invoices` insert row. A story test
 * spreads this into `tx.insert(invoices).values({ tenantId, memberId, planId,
 * planYear, draftByUserId, ...seed })`, supplying the tenant + subject
 * identity columns its scenario requires.
 */
export interface TaxFlowInvoiceSeed {
  readonly invoiceId: string;
  readonly invoiceSubject: 'membership' | 'event';
  readonly status: 'draft' | 'issued' | 'paid' | 'void' | 'credited' | 'partially_credited';
  readonly currency: string;
  readonly fiscalYear: number;
  /** Non-§87 bill number (SC), allocated at issue. NULL only on drafts. */
  readonly billDocumentNumberRaw: string | null;
  /** §87 RC receipt number, minted at payment. NULL before payment. */
  readonly receiptDocumentNumberRaw: string | null;
  /** §87 invoice-stream number — NULL in the new flow (bill is non-§87). */
  readonly sequenceNumber: number | null;
  readonly documentNumber: string | null;
  readonly pdfDocKind: PdfDocKind;
  readonly issueDate: string; // YYYY-MM-DD
  readonly dueDate: string; // YYYY-MM-DD
  /** Receipt (payment) date — Asia/Bangkok — set once paid. */
  readonly paymentDate: string | null;
  readonly subtotalSatang: Satang;
  readonly vatRateSnapshot: string; // 4-dp decimal string, e.g. '0.0700'
  readonly vatSatang: Satang;
  readonly totalSatang: Satang;
  /** 088 US8 — pinned per-invoice VAT treatment (column: migration 0234). */
  readonly vatTreatment: VatTreatment;
  readonly zeroRateCertNo: string | null;
  readonly zeroRateCertDate: string | null; // YYYY-MM-DD
}

const DEFAULT_ISSUE_DATE = '2026-03-15';
const DEFAULT_DUE_DATE = '2026-04-14';
const DEFAULT_FISCAL_YEAR = 2026;

/** Deterministic-ish UUID v4 for a fixture invoice (override per test). */
function fixtureInvoiceId(): string {
  // Not cryptographic — a stable-shape v4 literal; tests usually override.
  return '08800000-0000-4000-8000-000000000001';
}

/** VAT-7% base for a standard membership bill (12,000.00 THB subtotal). */
const STANDARD_SUBTOTAL: Satang = 1_200_000n;
const STANDARD_VAT: Satang = 84_000n; // 7% of 12,000.00
const STANDARD_TOTAL: Satang = STANDARD_SUBTOTAL + STANDARD_VAT;

/**
 * A pre-payment non-tax **ใบแจ้งหนี้ / Invoice** (data-model § A.1): issued,
 * a non-§87 `SC` bill number, NO §87 sequence/document number, VAT 7%.
 */
export function makeBillInvoiceSeed(
  overrides: Partial<TaxFlowInvoiceSeed> = {},
): TaxFlowInvoiceSeed {
  return {
    invoiceId: fixtureInvoiceId(),
    invoiceSubject: 'membership',
    status: 'issued',
    currency: 'THB',
    fiscalYear: DEFAULT_FISCAL_YEAR,
    billDocumentNumberRaw: 'SC-2026-000001',
    receiptDocumentNumberRaw: null,
    sequenceNumber: null,
    documentNumber: null,
    pdfDocKind: 'invoice',
    issueDate: DEFAULT_ISSUE_DATE,
    dueDate: DEFAULT_DUE_DATE,
    paymentDate: null,
    subtotalSatang: STANDARD_SUBTOTAL,
    vatRateSnapshot: '0.0700',
    vatSatang: STANDARD_VAT,
    totalSatang: STANDARD_TOTAL,
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    zeroRateCertDate: null,
    ...overrides,
  };
}

/**
 * The **ใบกำกับภาษี/ใบเสร็จรับเงิน** §86/4 + §105ทวิ tax receipt (data-model
 * § A.2): the SAME row after payment — `paid`, `receipt_combined`, still
 * carrying its `SC` bill number PLUS the §87 `RC` receipt number minted at the
 * payment date. `document_number`/`sequence_number` stay NULL.
 */
export function makeTaxReceiptInvoiceSeed(
  overrides: Partial<TaxFlowInvoiceSeed> = {},
): TaxFlowInvoiceSeed {
  return {
    ...makeBillInvoiceSeed(),
    status: 'paid',
    receiptDocumentNumberRaw: 'RC-2026-000001',
    pdfDocKind: 'receipt_combined',
    paymentDate: '2026-03-20',
    ...overrides,
  };
}

/**
 * A **§80/1(5) zero-rated** embassy / int'l-org bill (data-model § F.8): a
 * NON-membership event/service bill at VAT 0% with a captured MFA certificate
 * (fail-closed — `zero_rate_cert_no` is required). Membership can never be
 * zero-rated, so the default subject is `event`.
 */
export function makeZeroRateInvoiceSeed(
  overrides: Partial<TaxFlowInvoiceSeed> = {},
): TaxFlowInvoiceSeed {
  return {
    ...makeBillInvoiceSeed(),
    invoiceSubject: 'event',
    vatTreatment: 'zero_rated_80_1_5',
    vatRateSnapshot: '0.0000',
    vatSatang: 0n,
    totalSatang: STANDARD_SUBTOTAL, // total = base at 0% VAT
    zeroRateCertNo: 'กต 0404/1234',
    zeroRateCertDate: '2026-03-10',
    ...overrides,
  };
}
