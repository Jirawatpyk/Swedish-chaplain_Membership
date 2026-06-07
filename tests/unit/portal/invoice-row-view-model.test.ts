/**
 * 060-member-portal-d4 — unit tests for `toInvoiceRowViewModel`.
 *
 * The pure view-model is the SINGLE source of truth for the per-row
 * presentation flags rendered by the member-portal invoice desktop
 * table and the upcoming mobile card list. These boundary tests pin the
 * EXACT flag logic that was extracted verbatim from `page.tsx`'s inline
 * `<TableBody>` row map — any future "improvement" to a boolean that
 * silently diverges the table from the card fails here.
 *
 * Coverage:
 *   - displayStatus: overdue derivation (issued + past-due → 'overdue';
 *     non-issued stays put; issued-not-past-due stays 'issued')
 *   - statuses: issued / paid / void / credited / partially_credited
 *   - isCombinedPaid: paid + receiptNumber null + receiptPdfStatus
 *     'rendered' (combined) vs paid + receiptNumber set (separate)
 *   - showInvoice / showReceipt / receiptPending across the receipt PDF
 *     state machine (null / pending / failed / rendered)
 *   - resendable: false on void, true on non-void with a PDF
 *   - raw field passthrough (documentNumber / receiptNumber / dates /
 *     total / invoiceId)
 *
 * Purity: `nowUtcIso` is always passed explicitly — the VM never reads
 * the wall clock.
 */
import { describe, expect, it } from 'vitest';
import { toInvoiceRowViewModel } from '@/app/(member)/portal/invoices/_utils/invoice-row-view-model';
import { asInvoiceId, type Invoice } from '@/modules/invoicing';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asFiscalYearUnsafe } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { makeMemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { makeTenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';

const INVOICE_UUID = '11111111-2222-4333-8444-555555555555';
// A fixed "now" comfortably PAST the fixtures' dueDate (2026-04-30) so
// an `issued` invoice derives overdue unless a test overrides dueDate.
const NOW_PAST_DUE = '2026-05-15T03:00:00Z';
// A fixed "now" BEFORE the fixtures' dueDate so `issued` stays `issued`.
const NOW_BEFORE_DUE = '2026-04-10T03:00:00Z';

function sha(): Sha256Hex {
  const r = Sha256Hex.parse('a'.repeat(64));
  if (!r.ok) throw new Error('bad fixture hash');
  return r.value;
}

function docNum(): DocumentNumber {
  const r = DocumentNumber.parse('INV-2026-000001');
  if (!r.ok) throw new Error('bad fixture doc number');
  return r.value;
}

/**
 * Full membership `Invoice` fixture. Defaults to a plain `issued`
 * invoice with a rendered PDF, no payment, no receipt — overrides tune
 * the fields each boundary test cares about.
 */
function buildInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    tenantId: 't',
    invoiceId: asInvoiceId(INVOICE_UUID),
    memberId: 'm',
    planId: 'p',
    planYear: 2026,
    status: 'issued',
    draftByUserId: 'u',
    fiscalYear: asFiscalYearUnsafe(2026),
    sequenceNumber: 1,
    documentNumber: docNum(),
    issueDate: '2026-04-01',
    dueDate: '2026-04-30',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromSatangUnsafe(100_00n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_00n),
    total: Money.fromSatangUnsafe(107_00n),
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: 30,
    tenantIdentitySnapshot: makeTenantIdentitySnapshot({
      legal_name_th: 'x',
      legal_name_en: 'x',
      tax_id: '0',
      address_th: 'x',
      address_en: 'x',
      logo_blob_key: null,
    }),
    memberIdentitySnapshot: makeMemberIdentitySnapshot({
      legal_name: 'x',
      tax_id: null,
      address: 'x',
      primary_contact_name: 'x',
      primary_contact_email: 'contact@example.com',
    }),
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: { blobKey: 'k', sha256: sha(), templateVersion: 1 },
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    lines: [],
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  } as Invoice;
}

describe('toInvoiceRowViewModel — displayStatus / overdue derivation', () => {
  it('swaps issued → overdue when Bangkok-today is past dueDate', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ status: 'issued' }), NOW_PAST_DUE);
    expect(vm.displayStatus).toBe('overdue');
  });

  it('keeps issued when not yet past dueDate', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ status: 'issued' }), NOW_BEFORE_DUE);
    expect(vm.displayStatus).toBe('issued');
  });

  it('never marks a paid invoice overdue, even when past due', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'paid', receiptPdfStatus: 'rendered' }),
      NOW_PAST_DUE,
    );
    expect(vm.displayStatus).toBe('paid');
  });

  it('passes void through unchanged (never overdue)', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ status: 'void' }), NOW_PAST_DUE);
    expect(vm.displayStatus).toBe('void');
  });

  it('passes credited through unchanged (never overdue)', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ status: 'credited' }), NOW_PAST_DUE);
    expect(vm.displayStatus).toBe('credited');
  });

  it('passes partially_credited through unchanged (never overdue)', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'partially_credited' }),
      NOW_PAST_DUE,
    );
    expect(vm.displayStatus).toBe('partially_credited');
  });
});

describe('toInvoiceRowViewModel — combined vs separate receipt mode', () => {
  it('combined-mode: paid + null receiptNumber + rendered → isCombinedPaid true', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'rendered',
      }),
      NOW_PAST_DUE,
    );
    expect(vm.isCombinedPaid).toBe(true);
    // Combined-paid hides the (stale) invoice anchor.
    expect(vm.showInvoice).toBe(false);
    expect(vm.showReceipt).toBe(true);
    expect(vm.receiptNumber).toBeNull();
  });

  it('separate-mode: paid + receiptNumber set + rendered → isCombinedPaid false, both shown', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptDocumentNumberRaw: 'RCP-2026-000009',
        receiptPdfStatus: 'rendered',
      }),
      NOW_PAST_DUE,
    );
    expect(vm.isCombinedPaid).toBe(false);
    expect(vm.showInvoice).toBe(true);
    expect(vm.showReceipt).toBe(true);
    expect(vm.receiptNumber).toBe('RCP-2026-000009');
  });

  it('paid + null receiptNumber but receipt NOT yet rendered → not combined (status pending)', () => {
    // isCombinedPaid requires receiptPdfStatus === 'rendered'; a pending
    // receipt is not yet the combined document.
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'pending',
      }),
      NOW_PAST_DUE,
    );
    expect(vm.isCombinedPaid).toBe(false);
    // PDF exists and it is not combined-paid → invoice download shown.
    expect(vm.showInvoice).toBe(true);
    expect(vm.showReceipt).toBe(false);
  });
});

describe('toInvoiceRowViewModel — receipt PDF state machine', () => {
  it('receiptPdfStatus null on a paid invoice → no receipt, no pending', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'paid', receiptPdfStatus: null }),
      NOW_PAST_DUE,
    );
    expect(vm.showReceipt).toBe(false);
    expect(vm.receiptPending).toBe(false);
    // Not combined (needs 'rendered'); PDF present → invoice shown.
    expect(vm.isCombinedPaid).toBe(false);
    expect(vm.showInvoice).toBe(true);
  });

  it("receiptPdfStatus 'pending' on a paid invoice → receiptPending true", () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'paid', receiptPdfStatus: 'pending' }),
      NOW_PAST_DUE,
    );
    expect(vm.receiptPending).toBe(true);
    expect(vm.showReceipt).toBe(false);
  });

  it("receiptPdfStatus 'failed' on a paid invoice → receiptPending true", () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'paid', receiptPdfStatus: 'failed' }),
      NOW_PAST_DUE,
    );
    expect(vm.receiptPending).toBe(true);
    expect(vm.showReceipt).toBe(false);
  });

  it("receiptPdfStatus 'rendered' on a paid invoice → showReceipt true, not pending", () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'paid', receiptPdfStatus: 'rendered' }),
      NOW_PAST_DUE,
    );
    expect(vm.showReceipt).toBe(true);
    expect(vm.receiptPending).toBe(false);
  });

  it('an issued (unpaid) invoice never shows a receipt or pending state', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'issued', receiptPdfStatus: null }),
      NOW_BEFORE_DUE,
    );
    expect(vm.showReceipt).toBe(false);
    expect(vm.receiptPending).toBe(false);
    expect(vm.isCombinedPaid).toBe(false);
  });
});

describe('toInvoiceRowViewModel — showInvoice', () => {
  it('true when a PDF exists and the row is not combined-paid', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ status: 'issued' }), NOW_BEFORE_DUE);
    expect(vm.showInvoice).toBe(true);
  });

  it('false when the invoice has no PDF (e.g. a draft would have pdf null)', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ pdf: null }), NOW_BEFORE_DUE);
    expect(vm.showInvoice).toBe(false);
  });

  it('a void invoice with a PDF still shows the (voided) invoice download', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ status: 'void' }), NOW_PAST_DUE);
    expect(vm.showInvoice).toBe(true);
  });
});

describe('toInvoiceRowViewModel — resendable', () => {
  it('false on a void invoice even when a PDF exists', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ status: 'void' }), NOW_PAST_DUE);
    expect(vm.resendable).toBe(false);
  });

  it('true on an issued invoice with a PDF', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ status: 'issued' }), NOW_BEFORE_DUE);
    expect(vm.resendable).toBe(true);
  });

  it('true on a paid invoice with a PDF', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'paid', receiptPdfStatus: 'rendered' }),
      NOW_PAST_DUE,
    );
    expect(vm.resendable).toBe(true);
  });

  it('false when there is no PDF, even if not void', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'issued', pdf: null }),
      NOW_BEFORE_DUE,
    );
    expect(vm.resendable).toBe(false);
  });
});

describe('toInvoiceRowViewModel — raw field passthrough', () => {
  it('exposes invoiceId, raw documentNumber, dates and total unchanged', () => {
    const inv = buildInvoice({ status: 'issued' });
    const vm = toInvoiceRowViewModel(inv, NOW_BEFORE_DUE);
    expect(vm.invoiceId).toBe(inv.invoiceId);
    expect(vm.documentNumber).toBe('INV-2026-000001');
    expect(vm.issueDate).toBe('2026-04-01');
    expect(vm.dueDate).toBe('2026-04-30');
    expect(vm.total).toBe(inv.total);
  });

  it('documentNumber is null when the invoice has no document number (draft shape)', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ documentNumber: null }), NOW_BEFORE_DUE);
    expect(vm.documentNumber).toBeNull();
  });

  it('receiptNumber is null in combined-mode and the raw string in separate-mode', () => {
    const combined = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'rendered',
      }),
      NOW_PAST_DUE,
    );
    expect(combined.receiptNumber).toBeNull();

    const separate = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptDocumentNumberRaw: 'RCP-2026-000009',
        receiptPdfStatus: 'rendered',
      }),
      NOW_PAST_DUE,
    );
    expect(separate.receiptNumber).toBe('RCP-2026-000009');
  });
});
