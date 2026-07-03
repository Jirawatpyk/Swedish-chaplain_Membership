/**
 * 060-member-portal-d4 — unit tests for `toInvoiceRowViewModel`.
 *
 * The pure view-model is the SINGLE source of truth for the per-row
 * presentation flags rendered by the member-portal invoice desktop
 * table and the mobile card list. These boundary tests pin the EXACT
 * flag logic the view-model exposes. Most flags (`isCombinedPaid` /
 * `showInvoice` / `showReceipt` / `resendable`) were extracted verbatim
 * from `page.tsx`'s former inline `<TableBody>` row map, but the
 * receipt-PDF flags are NOT all verbatim: the S1 fix narrowed
 * `receiptPending` to the 'pending' state ONLY and added a separate
 * `receiptFailed` ('failed') flag (see the source VM header). The
 * invariant these tests guard is therefore PARITY — both surfaces
 * consume one view-model, so any flag change lands on both at once and
 * they can never drift apart — NOT byte-identical D3 output.
 *
 * Coverage:
 *   - displayStatus: overdue derivation (issued + past-due → 'overdue';
 *     non-issued stays put; issued-not-past-due stays 'issued')
 *   - statuses: issued / paid / void / credited / partially_credited
 *   - isCombinedPaid: paid + receiptNumber null + receiptPdfStatus
 *     'rendered' (combined) vs paid + receiptNumber set (separate)
 *   - showInvoice / showReceipt / receiptPending / receiptFailed across the
 *     receipt PDF state machine (null / pending / failed / rendered).
 *     receiptPending fires ONLY for the non-terminal 'pending' state;
 *     a terminal 'failed' render fires receiptFailed (NEVER receiptPending)
 *     so a permanent failure is never mislabelled as in-progress (S1 fix).
 *   - resendable: false on void, true on non-void with a PDF
 *   - rowHasAnyAction: derived OR of the FIVE action flags (the shared
 *     empty-actions sentinel gate) — includes receiptFailed so a paid +
 *     pdf=null + failed-receipt row keeps its terminal affordance and does
 *     NOT collapse to the '—' sentinel
 *   - raw field passthrough (documentNumber / receiptNumber / dates /
 *     total / invoiceId)
 *
 * Purity: `nowUtcIso` is always passed explicitly — the VM never reads
 * the wall clock.
 */
import { describe, expect, it } from 'vitest';
import {
  toInvoiceRowViewModel,
  rowHasAnyAction,
} from '@/app/(member)/portal/invoices/_utils/invoice-row-view-model';
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
 *
 * The membership discriminant fields (`invoiceSubject: 'membership'`,
 * `vatInclusive: false`, `eventId`/`eventRegistrationId: null`) are set so
 * the object STRUCTURALLY satisfies the `Invoice` discriminated union with
 * NO `as Invoice` cast — narrowing on `invoiceSubject === 'membership'`
 * then guarantees `memberId`/`planId`/`planYear` non-null and the event
 * fields null, which is exactly the shape this fixture builds.
 *
 * `overrides` is typed `Partial<Extract<Invoice, { invoiceSubject:
 * 'membership' }>>` — i.e. partial of the MEMBERSHIP arm only, not of the
 * raw `Invoice` union. `Partial<Invoice>` distributes to `Partial<member>
 * | Partial<event>`, and spreading that widens the result's
 * `invoiceSubject` to `'membership' | 'event'` (and `vatInclusive` to
 * `boolean`), so the literal no longer narrows to a single arm and stops
 * matching `Invoice` (the old reason `as Invoice` was needed). Pinning the
 * override type to the membership arm keeps the discriminants narrow, so
 * the returned object satisfies `Invoice` with no cast. Every test
 * override only tweaks shared lifecycle/PDF fields, never the subject
 * discriminant, so the narrower type is fully sufficient.
 */
function buildInvoice(
  overrides: Partial<Extract<Invoice, { invoiceSubject: 'membership' }>> = {},
): Invoice {
  return {
    tenantId: 't',
    invoiceId: asInvoiceId(INVOICE_UUID),
    invoiceSubject: 'membership',
    memberId: 'm',
    planId: 'p',
    planYear: 2026,
    eventId: null,
    eventRegistrationId: null,
    vatInclusive: false,
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
    pdfDocKind: 'invoice',
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    billDocumentNumberRaw: null,
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    zeroRateCertDate: null,
    zeroRateCertBlobKey: null,
    lines: [],
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
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
    // 064 — bill-first rows always persist the receipt BLOB together with
    // `receiptPdfStatus 'rendered'` (record-payment inline + worker paths);
    // 'rendered' with a NULL blob only occurs on as-paid rows. The fixture
    // carries the blob so it describes the real bill-first shape.
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'rendered',
        receiptPdf: { blobKey: 'rk', sha256: sha(), templateVersion: 1 },
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
        receiptPdf: { blobKey: 'rk', sha256: sha(), templateVersion: 1 },
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

describe('toInvoiceRowViewModel — credited receipt-number visibility (D3 invariant)', () => {
  // D3 receipt-visibility invariant: `showReceipt` is gated on
  // `status === 'paid'`, so a CREDITED / PARTIALLY_CREDITED invoice that
  // happens to carry a separate-mode receipt number must NOT offer a
  // receipt download — but its raw receipt number STILL passes through to
  // `vm.receiptNumber` (the column displays it; only the download is
  // withheld). These pin that pair against a future broadening of
  // `showReceipt` that would leak a receipt action on a credited row.
  it('credited + receiptNumber + rendered → showReceipt false, receiptNumber preserved', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'credited',
        receiptDocumentNumberRaw: 'RCP-2026-0001',
        receiptPdfStatus: 'rendered',
      }),
      NOW_PAST_DUE,
    );
    expect(vm.showReceipt).toBe(false);
    expect(vm.receiptNumber).toBe('RCP-2026-0001');
    // Credited is not combined-paid either (needs status 'paid').
    expect(vm.isCombinedPaid).toBe(false);
    // R6 mutation guard: a credited invoice with its (issue-time) PDF STILL
    // offers the invoice download + resend, and therefore is NOT an
    // empty-action row. `showInvoice` is gated on `pdf !== null && !combinedPaid`
    // and `resendable` on `status !== 'void' && pdf !== null` — neither is
    // gated on `status === 'issued'`. A future change narrowing `showInvoice`
    // to issued-only would silently drop the credited row's invoice button
    // (and, via the OR, could flip `rowHasAnyAction` to false → '—' sentinel)
    // with no test catching it. These pin the correct credited+PDF values.
    expect(vm.showInvoice).toBe(true);
    expect(vm.resendable).toBe(true);
    expect(rowHasAnyAction(vm)).toBe(true);
  });

  it('partially_credited + receiptNumber + rendered → showReceipt false, receiptNumber preserved', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'partially_credited',
        receiptDocumentNumberRaw: 'RCP-2026-0001',
        receiptPdfStatus: 'rendered',
      }),
      NOW_PAST_DUE,
    );
    expect(vm.showReceipt).toBe(false);
    expect(vm.receiptNumber).toBe('RCP-2026-0001');
    expect(vm.isCombinedPaid).toBe(false);
    // R6 mutation guard (see the credited case above) — identical reasoning:
    // partially_credited + its PDF keeps invoice download + resend live, so the
    // row is never an empty-action '—' sentinel.
    expect(vm.showInvoice).toBe(true);
    expect(vm.resendable).toBe(true);
    expect(rowHasAnyAction(vm)).toBe(true);
  });
});

describe('rowHasAnyAction (shared empty-actions sentinel gate)', () => {
  // `rowHasAnyAction(vm)` is the derived OR of the four action flags; both
  // the desktop table cell and the mobile card branch on `!rowHasAnyAction(vm)`
  // to render the em-dash sentinel instead of an (empty) action group.
  it('true when there is something to download (paid + rendered receipt)', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptPdfStatus: 'rendered',
        receiptPdf: { blobKey: 'rk', sha256: sha(), templateVersion: 1 },
      }),
      NOW_PAST_DUE,
    );
    // showReceipt + resendable both fire → rowHasAnyAction true.
    expect(rowHasAnyAction(vm)).toBe(true);
  });

  it('false when an issued invoice has no PDF and no receipt state (all four flags off)', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'issued', pdf: null, receiptPdfStatus: null }),
      NOW_BEFORE_DUE,
    );
    // No PDF → showInvoice/resendable false; not paid → showReceipt/
    // receiptPending false. Nothing to show → sentinel.
    expect(vm.showInvoice).toBe(false);
    expect(vm.showReceipt).toBe(false);
    expect(vm.receiptPending).toBe(false);
    expect(vm.resendable).toBe(false);
    expect(rowHasAnyAction(vm)).toBe(false);
  });

  it('true for a void invoice that still has its PDF (via showInvoice)', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ status: 'void' }), NOW_PAST_DUE);
    // Void suppresses resend but the voided-invoice download stays.
    expect(vm.resendable).toBe(false);
    expect(vm.showInvoice).toBe(true);
    expect(rowHasAnyAction(vm)).toBe(true);
  });

  it('true when receiptPending is the SOLE contributor (paid + pdf null + receipt mid-render)', () => {
    // R7 mutation guard: a paid invoice whose issue-time PDF is absent but whose
    // §105ทวิ receipt is still rendering. Only `receiptPending` fires —
    // showInvoice (pdf null), showReceipt (not 'rendered') and resendable (pdf
    // null) are all false — so this row's "Preparing receipt…" affordance hangs
    // ENTIRELY off receiptPending in the OR. A refactor dropping receiptPending
    // from `rowHasAnyAction` would silently render this row as the '—' sentinel.
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'paid', pdf: null, receiptPdfStatus: 'pending' }),
      NOW_PAST_DUE,
    );
    expect(vm.showInvoice).toBe(false);
    expect(vm.showReceipt).toBe(false);
    expect(vm.resendable).toBe(false);
    expect(vm.receiptPending).toBe(true);
    expect(rowHasAnyAction(vm)).toBe(true);
  });

  it('true when receiptFailed is the SOLE contributor (paid + pdf null + receipt render FAILED) — S1', () => {
    // S1 fix: a paid invoice whose issue-time PDF is absent AND whose §105ทวิ
    // receipt render TERMINALLY failed. Only `receiptFailed` fires —
    // showInvoice (pdf null), showReceipt (not 'rendered'), receiptPending
    // (not 'pending') and resendable (pdf null) are all false. The terminal
    // "Receipt unavailable" affordance hangs ENTIRELY off receiptFailed in the
    // OR, so this row MUST NOT collapse to the '—' sentinel — that would hide
    // the only signal the member has that their receipt permanently failed.
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'paid', pdf: null, receiptPdfStatus: 'failed' }),
      NOW_PAST_DUE,
    );
    expect(vm.showInvoice).toBe(false);
    expect(vm.showReceipt).toBe(false);
    expect(vm.receiptPending).toBe(false);
    expect(vm.resendable).toBe(false);
    expect(vm.receiptFailed).toBe(true);
    expect(rowHasAnyAction(vm)).toBe(true);
  });
});

describe('toInvoiceRowViewModel — receipt PDF state machine', () => {
  it('receiptPdfStatus null on a paid invoice → no receipt, no pending, no failed', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'paid', receiptPdfStatus: null }),
      NOW_PAST_DUE,
    );
    expect(vm.showReceipt).toBe(false);
    expect(vm.receiptPending).toBe(false);
    expect(vm.receiptFailed).toBe(false);
    // Not combined (needs 'rendered'); PDF present → invoice shown.
    expect(vm.isCombinedPaid).toBe(false);
    expect(vm.showInvoice).toBe(true);
  });

  it("receiptPdfStatus 'pending' on a paid invoice → receiptPending true, receiptFailed false", () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'paid', receiptPdfStatus: 'pending' }),
      NOW_PAST_DUE,
    );
    expect(vm.receiptPending).toBe(true);
    // S1: 'pending' is the genuine in-progress state — NOT terminal-failed.
    expect(vm.receiptFailed).toBe(false);
    expect(vm.showReceipt).toBe(false);
  });

  it("receiptPdfStatus 'failed' on a paid invoice → receiptFailed true, receiptPending false (S1)", () => {
    // S1 fix: a TERMINAL 'failed' render must NOT be reported as
    // receiptPending — that mislabelled a permanent failure as a perpetual
    // aria-busy "preparing" spinner. It is now the terminal `receiptFailed`
    // flag (drives a static, non-busy "Receipt unavailable" affordance).
    const vm = toInvoiceRowViewModel(
      buildInvoice({ status: 'paid', receiptPdfStatus: 'failed' }),
      NOW_PAST_DUE,
    );
    expect(vm.receiptFailed).toBe(true);
    expect(vm.receiptPending).toBe(false);
    expect(vm.showReceipt).toBe(false);
    // A failed-receipt row is NOT combined-paid (needs 'rendered'); its
    // issue-time PDF (default fixture) still offers the invoice download.
    expect(vm.isCombinedPaid).toBe(false);
  });

  it("receiptPdfStatus 'rendered' on a paid invoice → showReceipt true, not pending, not failed", () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptPdfStatus: 'rendered',
        receiptPdf: { blobKey: 'rk', sha256: sha(), templateVersion: 1 },
      }),
      NOW_PAST_DUE,
    );
    expect(vm.showReceipt).toBe(true);
    expect(vm.receiptPending).toBe(false);
    expect(vm.receiptFailed).toBe(false);
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

describe('toInvoiceRowViewModel — 064 as-paid event invoices (main PDF IS the final document)', () => {
  // `applyIssueAsPaid` lands rows as: status 'paid', receiptPdfStatus
  // 'rendered', receipt blob columns NULL — because the MAIN pdf already IS
  // the final legal document (`pdfDocKind` 'receipt_combined' for TIN buyers,
  // 'receipt_separate' for the no-TIN β stream). A matched member legitimately
  // sees these admin-issued event receipts in the portal (list filters by
  // memberId). The VM reads InvoiceCommon fields only, so the membership
  // fixture is shape-sufficient here.
  it('as-paid TIN (receipt_combined main pdf): main download stays, with the combined flag; no broken receipt action', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'rendered',
        receiptPdf: null,
        pdfDocKind: 'receipt_combined',
      }),
      NOW_PAST_DUE,
    );
    expect(vm.mainPdfKind).toBe('combined');
    // NOT combined-paid in the stale-draft-hiding sense: the main pdf is the
    // final combined doc, not an issue-time pre-payment invoice.
    expect(vm.isCombinedPaid).toBe(false);
    // Pre-fix: showInvoice false + showReceipt true → the row's ONLY visible
    // download pointed at receiptPdf (NULL) and 502'd (blob_missing).
    expect(vm.showInvoice).toBe(true);
    expect(vm.showReceipt).toBe(false);
    expect(vm.receiptPending).toBe(false);
    expect(vm.receiptFailed).toBe(false);
    expect(rowHasAnyAction(vm)).toBe(true);
  });

  it('as-paid no-TIN β (receipt_separate main pdf): no broken receipt action; main download stays, wearing the RECEIPT kind', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        documentNumber: null, // β — invoice-stream pair is legitimately NULL
        receiptDocumentNumberRaw: 'RCP-2026-000777',
        receiptPdfStatus: 'rendered',
        receiptPdf: null,
        pdfDocKind: 'receipt_separate',
      }),
      NOW_PAST_DUE,
    );
    // 064 remediation S3 — the main pdf IS the §105 receipt: the download
    // label/aria flip to the receipt wording (NOT the combined dual-role one,
    // which stays TIN-combined only).
    expect(vm.mainPdfKind).toBe('receipt');
    expect(vm.isCombinedPaid).toBe(false);
    expect(vm.showInvoice).toBe(true);
    // Pre-fix: 'rendered' alone implied showReceipt → 502 (no receipt blob).
    expect(vm.showReceipt).toBe(false);
    // 064 remediation S3 — the display number resolves to the printed §105
    // receipt number; surfaces must NEVER fall back to the row UUID.
    expect(vm.displayNumber).toBe('RCP-2026-000777');
  });

  it('bill-first combined row (issue-time invoice main pdf + rendered receipt blob) is byte-identical', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'rendered',
        receiptPdf: { blobKey: 'rk', sha256: sha(), templateVersion: 1 },
        pdfDocKind: 'invoice',
      }),
      NOW_PAST_DUE,
    );
    expect(vm.mainPdfKind).toBe('invoice');
    expect(vm.isCombinedPaid).toBe(true);
    expect(vm.showInvoice).toBe(false);
    expect(vm.showReceipt).toBe(true);
  });
});

describe('toInvoiceRowViewModel — raw field passthrough', () => {
  it('exposes invoiceId, raw documentNumber, dates and total unchanged', () => {
    const inv = buildInvoice({ status: 'issued' });
    const vm = toInvoiceRowViewModel(inv, NOW_BEFORE_DUE);
    expect(vm.invoiceId).toBe(inv.invoiceId);
    expect(vm.documentNumber).toBe('INV-2026-000001');
    // displayNumber resolves to the invoice number on normal rows…
    expect(vm.displayNumber).toBe('INV-2026-000001');
    expect(vm.issueDate).toBe('2026-04-01');
    expect(vm.dueDate).toBe('2026-04-30');
    expect(vm.total).toBe(inv.total);
  });

  it('displayNumber prefers the invoice number even when a separate receipt number also exists', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptDocumentNumberRaw: 'RCP-2026-000009',
        receiptPdfStatus: 'rendered',
      }),
      NOW_PAST_DUE,
    );
    expect(vm.displayNumber).toBe('INV-2026-000001');
  });

  it('documentNumber AND displayNumber are null when the invoice has no number at all (draft shape)', () => {
    const vm = toInvoiceRowViewModel(buildInvoice({ documentNumber: null }), NOW_BEFORE_DUE);
    expect(vm.documentNumber).toBeNull();
    expect(vm.displayNumber).toBeNull();
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

// ===========================================================================
// 088 — tax-at-payment two-document (SC bill ↔ RC §86/4 tax receipt)
// disambiguation (T065 / T065a / FR-016).
//
// The mapper's THIRD arg (`taxAtPayment`, default false) gates the new
// disambiguation fields so a flag-OFF render stays byte-identical to legacy
// (every existing 2-arg call above resolves `taxDocumentKind: 'none'`). An
// 088 row's document identity lives across two columns:
//   - `billDocumentNumberRaw` — the pre-payment NON-§87 bill (SC-…).
//   - `documentNumber`         — NULL on a new-flow bill (never a §87 invoice).
//   - `receiptDocumentNumberRaw` — the §86/4 §87 RC receipt, minted at payment.
// So a PAID 088 bill has documentNumber NULL + billDocumentNumberRaw set +
// receiptDocumentNumberRaw set; an UNPAID 088 bill has both §87 legs NULL and
// only the SC bill number (which `displayDocumentNumber` does NOT resolve →
// the row would render an em-dash without `primaryNumber`'s bill fallback).
// ===========================================================================
describe('toInvoiceRowViewModel — 088 tax-at-payment disambiguation', () => {
  it('flag OFF (default 2-arg): an 088-bill-shaped row resolves taxDocumentKind "none" (backward compat)', () => {
    // Even a paid 088-bill shape (documentNumber null, bill + receipt set)
    // stays legacy when the flag is off — the surfaces render as today.
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        documentNumber: null,
        billDocumentNumberRaw: 'SC-2026-000045',
        receiptDocumentNumberRaw: 'RC-2026-000123',
        receiptPdfStatus: 'rendered',
        receiptPdf: { blobKey: 'rk', sha256: sha(), templateVersion: 1 },
      }),
      NOW_PAST_DUE,
      // taxAtPayment omitted → false
    );
    expect(vm.taxDocumentKind).toBe('none');
    expect(vm.billDocumentNumber).toBeNull();
    // primaryNumber falls back to displayNumber (here the RC via the §105/§86-4
    // fallback) exactly as the legacy surfaces already show.
    expect(vm.primaryNumber).toBe(vm.displayNumber);
    expect(vm.primaryNumber).toBe('RC-2026-000123');
  });

  it('flag ON, UNPAID 088 bill (both §87 legs NULL) → kind "bill"; primaryNumber is the SC number (never em-dash)', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'issued',
        documentNumber: null,
        billDocumentNumberRaw: 'SC-2026-000045',
        receiptDocumentNumberRaw: null,
      }),
      NOW_BEFORE_DUE,
      true,
    );
    expect(vm.taxDocumentKind).toBe('bill');
    expect(vm.billDocumentNumber).toBe('SC-2026-000045');
    // displayNumber (the §87 resolver) is null for an unpaid bill; primaryNumber
    // falls back to the SC bill so the row never renders '—'.
    expect(vm.displayNumber).toBeNull();
    expect(vm.primaryNumber).toBe('SC-2026-000045');
    // No RC receipt yet.
    expect(vm.receiptNumber).toBeNull();
  });

  it('flag ON, PAID 088 bill (RC minted) → kind "tax_receipt"; primaryNumber is the RC, billDocumentNumber is the SC, receiptNumber is the RC', () => {
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        documentNumber: null,
        billDocumentNumberRaw: 'SC-2026-000045',
        receiptDocumentNumberRaw: 'RC-2026-000123',
        receiptPdfStatus: 'rendered',
        receiptPdf: { blobKey: 'rk', sha256: sha(), templateVersion: 1 },
      }),
      NOW_PAST_DUE,
      true,
    );
    expect(vm.taxDocumentKind).toBe('tax_receipt');
    // RC is the row's primary (tax) identity — "presented first" (T065).
    expect(vm.primaryNumber).toBe('RC-2026-000123');
    // SC bill exposed for the "payable record — tax receipt issued (see RC)".
    expect(vm.billDocumentNumber).toBe('SC-2026-000045');
    // RC number for the "see RC" cross-reference link.
    expect(vm.receiptNumber).toBe('RC-2026-000123');
    // The bill PDF stays downloadable after payment (FR-015): receipt number is
    // set → NOT combined-paid → showInvoice true; receipt also shown.
    expect(vm.isCombinedPaid).toBe(false);
    expect(vm.showInvoice).toBe(true);
    expect(vm.showReceipt).toBe(true);
  });

  it('flag ON, legacy row (billDocumentNumberRaw NULL) → kind "none" (only real 088 bills disambiguate)', () => {
    // A legacy separate-mode paid row can coexist while the flag is on. It has a
    // §87 invoice number AND an RC — but NO bill number, so it is NOT an 088
    // two-document row and must render legacy.
    const vm = toInvoiceRowViewModel(
      buildInvoice({
        status: 'paid',
        receiptDocumentNumberRaw: 'RC-2026-000009',
        receiptPdfStatus: 'rendered',
        receiptPdf: { blobKey: 'rk', sha256: sha(), templateVersion: 1 },
      }),
      NOW_PAST_DUE,
      true,
    );
    expect(vm.taxDocumentKind).toBe('none');
    expect(vm.billDocumentNumber).toBeNull();
    // Legacy row keeps its §87 invoice number as the primary identity.
    expect(vm.primaryNumber).toBe('INV-2026-000001');
  });
});
