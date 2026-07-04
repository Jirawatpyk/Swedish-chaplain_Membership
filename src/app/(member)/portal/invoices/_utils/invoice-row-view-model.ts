/**
 * 060-member-portal-d4 — Shared per-row view-model for the member-portal
 * invoice LIST.
 *
 * Single source of truth for the per-row presentation flags that the
 * desktop `<table>` and the mobile card list both render. Both surfaces
 * MUST consume `toInvoiceRowViewModel(...)` so they can never drift apart
 * (a flag fixed for the table is fixed for the card, and vice versa).
 *
 * PURITY CONTRACT (project convention — avoid impure time in testable
 * units): this function NEVER calls `new Date()` / `Date.now()`. The
 * caller passes `nowUtcIso` (the same `new Date().toISOString()` the
 * list page already computes once per render) so the overdue derivation
 * is deterministic and unit-testable at boundaries. Mirrors how
 * `page.tsx` derives `displayStatus` via `computeIsOverdue(r, nowUtcIso)`.
 *
 * Flag provenance: `isCombinedPaid` / `showInvoice` / `showReceipt` /
 * `resendable` were extracted VERBATIM from the D3 inline expressions that
 * previously lived in `page.tsx`'s `<TableBody>` row map. `receiptPending`
 * was deliberately NARROWED to `receiptPdfStatus === 'pending'` ONLY and a
 * new `receiptFailed` (`=== 'failed'`) flag was added by the S1 review fix
 * (commit 3f16631a) — so a terminally-failed receipt render now shows a
 * static "Receipt unavailable" affordance instead of a perpetual
 * "Preparing receipt…" spinner. The failed-receipt output therefore
 * DELIBERATELY differs from D3 (see the per-flag comments below).
 *
 * The real invariant to preserve is PARITY, not byte-identical D3 output:
 * the desktop `<table>` and the mobile card both consume this single
 * view-model, so any flag change lands on both surfaces at once and they
 * can never drift apart.
 *
 * i18n decision (for the mobile card): NO new keys added. The existing
 * column labels already read as inline card labels — EN
 * `portal.invoices.columns.issueDate` = "Issued" and `columns.dueDate`
 * = "Due" (TH "วันที่ออก"/"ครบกำหนด", SV "Utfärdad"/"Förfaller"). Adding
 * `card.issued`/`card.due` would duplicate identical values (Principle X
 * — Simplicity; Reusable Components). The card reuses the column keys.
 */
import type { Invoice } from '@/modules/invoicing';
import {
  computeIsOverdue,
  displayDocumentNumber,
  resolveTaxDocumentKind,
} from '@/modules/invoicing';
import type { Money } from '@/modules/invoicing';
import type { InvoiceRowDisplayStatus } from './format';

/**
 * Presentation status surfaced to the row — the stored `InvoiceStatus`
 * widened with the derived `'overdue'` value (T109 / FR-028). `'overdue'`
 * is presentation-only; the stored status is never `'overdue'`.
 *
 * Defined in `./format` (the leaf presentation util whose status helpers
 * are tied to this union) and re-exported here so this module's public
 * surface — and the `displayStatus` field below — stay unchanged.
 */
export type { InvoiceRowDisplayStatus };

/**
 * 088 (T065 / T065a / FR-016) — the kind of §86/4 tax document a row
 * represents, for the SC-bill ↔ RC-tax-receipt disambiguation. Resolved by
 * `toInvoiceRowViewModel` ONLY when the tax-at-payment flag is passed true AND
 * the row is a real 088 bill (`billDocumentNumberRaw !== null`):
 *
 *   - `'none'`        — flag off, OR a legacy / non-088 row. Surfaces render
 *                       exactly as today (backward compatible).
 *   - `'bill'`        — a new-flow ใบแจ้งหนี้ not yet paid (both §87 legs NULL).
 *                       Shown under its NON-§87 bill number (SC-…) + the
 *                       ใบแจ้งหนี้/Invoice label.
 *   - `'tax_receipt'` — a paid new-flow bill whose §86/4 RC receipt number has
 *                       been minted at payment. 088 A-refined (FR-016): the row
 *                       stays identified by its OWN (SC) bill number + the
 *                       ใบแจ้งหนี้/Invoice tag; the RC §86/4 tax receipt is
 *                       surfaced separately (a clickable link) in the
 *                       Receipt-No. column/line.
 */
export type InvoiceTaxDocumentKind = 'none' | 'bill' | 'tax_receipt';

/**
 * Everything a single invoice list row needs to render, computed once
 * and shared by the desktop table + mobile card. Raw document/receipt
 * numbers are kept as `string | null` (callers apply the `?? '—'` /
 * `?? invoiceId` fallbacks they already use for aria labels + display).
 *
 * The flag invariants — `receiptPending` XOR `receiptFailed` (a paid
 * receipt PDF is in exactly one terminal/non-terminal state), a
 * `'overdue'` `displayStatus` implies the stored status was `'issued'`,
 * and `rowHasAnyAction` = OR of the action flags — hold BY CONSTRUCTION
 * because they all flow from `toInvoiceRowViewModel`. Hand-building a VM
 * literal bypasses them; always go through the mapper.
 */
export interface InvoiceRowViewModel {
  readonly invoiceId: Invoice['invoiceId'];
  /** Raw invoice document number (e.g. `INV-2026-000001`), null on draft. */
  readonly documentNumber: string | null;
  /**
   * 064 remediation S3 — the printed §87/§105 number the row should be
   * DISPLAYED under (shared `displayDocumentNumber` helper): the invoice
   * document number, else — for β as-paid no-TIN event rows whose invoice-
   * stream pair is legitimately NULL — the printed §105 receipt number.
   * Null only on true drafts (which the portal never lists). Surfaces MUST
   * use this for the visible number + aria so a β row never renders as an
   * em-dash or a raw UUID.
   */
  readonly displayNumber: string | null;
  /** Presentation status (issued → overdue swap applied — T109 / FR-028). */
  readonly displayStatus: InvoiceRowDisplayStatus;
  /** Raw separate-mode receipt document number; null in combined-mode. */
  readonly receiptNumber: string | null;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly total: Money | null;
  /**
   * Combined-mode paid invoice (bill-first): the issue-time invoice PDF is
   * a stale pre-payment draft and the SEPARATE receipt blob (rendered at
   * record-payment, reusing the invoice number) is the combined legal
   * document. When true the table/card hides the (stale) invoice anchor and
   * shows only the combined Receipt download. 064 — excludes as-paid rows
   * (`mainPdfKind 'combined'`): their MAIN pdf already IS the final combined
   * doc, so hiding it would remove the row's only download.
   */
  readonly isCombinedPaid: boolean;
  /**
   * 064 — what the MAIN pdf actually is (the 064-remediation S3
   * generalisation of the former `mainPdfIsFinalCombined` boolean):
   *
   *   - `'combined'` — `pdfDocKind 'receipt_combined'` (as-paid TIN event
   *     invoice): table + card flip the main download's label/aria to the
   *     combined dual-role wording (`actions.downloadCombined[Aria]`).
   *   - `'receipt'` — `pdfDocKind 'receipt_separate'` (β as-paid no-TIN
   *     event row / legacy issued no-TIN row): the main pdf IS the §105
   *     receipt, so the label/aria flip to the receipt wording
   *     (`actions.downloadReceipt[Aria]`).
   *   - `'invoice'` — everything else (incl. NULL pdfDocKind legacy rows):
   *     the plain invoice label.
   */
  readonly mainPdfKind: 'invoice' | 'combined' | 'receipt';
  /** Show the invoice-PDF download (PDF exists and it is not combined-paid). */
  readonly showInvoice: boolean;
  /**
   * Show the receipt-PDF download (paid + receipt PDF rendered + the
   * receipt BLOB actually present). 064 — `receiptPdf !== null` matters:
   * as-paid rows land `receiptPdfStatus 'rendered'` with NULL receipt blob
   * columns (their main pdf is the document); a receipt action on them
   * 502'd (blob_missing). Bill-first rows always write blob + 'rendered'
   * together, so this is behaviour-identical for them.
   */
  readonly showReceipt: boolean;
  /**
   * Paid invoice whose receipt PDF is GENUINELY in-progress
   * (`receiptPdfStatus === 'pending'`). This is the ONLY non-terminal,
   * non-rendered state — surfaces the `aria-busy` "Receipt preparing…"
   * live region. A `'failed'` render is terminal and is reported by
   * `receiptFailed` instead (NEVER as pending) so a permanent failure is
   * never mislabelled as in-progress (S1 review fix — a terminal failure
   * presented as a perpetual spinner).
   */
  readonly receiptPending: boolean;
  /**
   * Paid invoice whose receipt PDF render has TERMINALLY failed
   * (`receiptPdfStatus === 'failed'`). Surfaces a static, non-busy
   * "Receipt unavailable" affordance (no spinner, no `aria-busy`) — the
   * terminal counterpart to `receiptPending`. The member can still
   * download the Invoice PDF when `showInvoice` is true, and clicking a
   * receipt action surfaces the existing 502 toast.
   */
  readonly receiptFailed: boolean;
  /** Resend the invoice email (not void + invoice PDF exists). */
  readonly resendable: boolean;
  /**
   * 088 (T065 / T065a / FR-016) — SC-bill ↔ RC-tax-receipt disambiguation
   * discriminator. `'none'` unless the caller passed `taxAtPayment: true` AND
   * this is a real 088 bill; see {@link InvoiceTaxDocumentKind}.
   */
  readonly taxDocumentKind: InvoiceTaxDocumentKind;
  /**
   * 088 — the pre-payment NON-§87 bill number (SC-…) to display, flag-aware:
   * the raw `billDocumentNumberRaw` when `taxDocumentKind !== 'none'`, else
   * `null` (a flag-off surface never surfaces it → byte-identical legacy).
   * Drives the "payable record" line on a paid bill and the row identity on an
   * unpaid bill.
   */
  readonly billDocumentNumber: string | null;
  /**
   * 088 A-refined (FR-016) — the number the row is DISPLAYED under, flag-aware.
   * For ANY 088 bill (`taxDocumentKind !== 'none'`, paid OR unpaid) this is the
   * invoice's OWN (SC) NON-§87 bill number — the invoice is always identified by
   * its own bill number, never swapped to the RC on payment. For legacy rows it
   * is `displayNumber` (the §87 invoice / §105 / §86-4 RC resolver). Surfaces use
   * this for the row link text + aria; the RC is surfaced separately in the
   * Receipt-No. column/line, and `displayNumber` stays unchanged for any consumer
   * that specifically wants the §87 number.
   */
  readonly primaryNumber: string | null;
}

/**
 * Whether the row has ANY document/action/state to render in its action
 * cell — a pure OR of the FIVE action flags. When false the row has no
 * downloadable document, no in-progress receipt, no terminally-failed
 * receipt, and is not resendable, so both the desktop table cell AND the
 * mobile card render the em-dash sentinel `—` instead of an (empty)
 * action group.
 *
 * `receiptFailed` is included so a paid + `pdf === null` + receipt-render-
 * failed row still surfaces its terminal "Receipt unavailable" affordance
 * (it must NOT collapse to the `—` sentinel — that would hide the only
 * signal the member has that their receipt render permanently failed).
 *
 * Derived on demand (not stored on the view-model) so it can never drift
 * out of sync with the flags it summarises — a literal can't set a stale
 * `hasAnyAction` that contradicts the action flags.
 */
export const rowHasAnyAction = (vm: InvoiceRowViewModel): boolean =>
  vm.showInvoice ||
  vm.showReceipt ||
  vm.receiptPending ||
  vm.receiptFailed ||
  vm.resendable;

/**
 * Wave-4 S17 — i18n key pair (in the `portal.invoices` list namespace) for
 * the MAIN pdf download button, keyed by what the main pdf actually IS.
 * Consumed by the desktop table, the mobile card AND the detail page so the
 * three surfaces can never drift on the 064 combined/receipt wording:
 *
 *   'combined' → dual-role ใบกำกับภาษี/ใบเสร็จรับเงิน wording (as-paid TIN);
 *   'receipt'  → §105 receipt wording (β as-paid no-TIN / legacy rows);
 *   'invoice'  → the plain invoice label.
 *
 * The VOID overlay stays per-surface on purpose: the list surfaces use
 * `actions.downloadVoided[Aria]` while the detail page deliberately uses its
 * own `void.downloadVoidedPdf` copy — folding it here would force one of
 * them to change keys.
 */
export function downloadLabelKeys(mainPdfKind: InvoiceRowViewModel['mainPdfKind']): {
  readonly labelKey:
    | 'actions.downloadCombined'
    | 'actions.downloadReceipt'
    | 'actions.download';
  readonly ariaKey:
    | 'actions.downloadCombinedAria'
    | 'actions.downloadReceiptAria'
    | 'actions.downloadInvoiceAria';
} {
  switch (mainPdfKind) {
    case 'combined':
      return { labelKey: 'actions.downloadCombined', ariaKey: 'actions.downloadCombinedAria' };
    case 'receipt':
      return { labelKey: 'actions.downloadReceipt', ariaKey: 'actions.downloadReceiptAria' };
    case 'invoice':
      return { labelKey: 'actions.download', ariaKey: 'actions.downloadInvoiceAria' };
  }
}

/**
 * Pure mapper. `nowUtcIso` MUST be supplied by the caller (do NOT call
 * `new Date()` here) so overdue derivation stays deterministic and the
 * view-model is testable at boundaries.
 *
 * `isCombinedPaid` / `showInvoice` / `showReceipt` / `resendable` are a
 * verbatim copy of the former D3 inline expressions in `page.tsx`;
 * `receiptPending` was narrowed and `receiptFailed` added by the S1 fix;
 * 064 made `isCombinedPaid` pdfDocKind-aware and gated `showReceipt` on the
 * receipt blob's presence; the 064 remediation generalised the former
 * `mainPdfIsFinalCombined` boolean into `mainPdfKind` (β receipt_separate
 * rows now get receipt labelling too) and added `displayNumber` — see the
 * per-flag comments below for each flag's exact condition and provenance.
 */
export function toInvoiceRowViewModel(
  row: Invoice,
  nowUtcIso: string,
  /**
   * 088 (T065 / FR-016) — tax-at-payment flag (`env.features.f088TaxAtPayment`).
   * Defaults to `false` so every existing 2-arg call — and thus every flag-off
   * surface — resolves `taxDocumentKind: 'none'` and renders byte-identically to
   * legacy. The caller (the list page) passes the live flag.
   */
  taxAtPayment = false,
): InvoiceRowViewModel {
  // T109 / FR-028 — `'issued'` swaps to `'overdue'` once Bangkok-today
  // has passed dueDate; every other stored status passes through.
  const displayStatus: InvoiceRowDisplayStatus = computeIsOverdue(row, nowUtcIso)
    ? 'overdue'
    : row.status;

  // 064 — as-paid event invoices persist the MAIN pdf as the final legal
  // document (issued straight to paid; receipt blob columns stay NULL,
  // receiptPdfStatus lands 'rendered'): 'receipt_combined' for TIN buyers,
  // 'receipt_separate' (a bare §105 receipt) for the no-TIN β stream.
  // Pre-064-fix the combined rows matched `isCombinedPaid` (hiding the main
  // download) while `showReceipt` pointed at the NULL receipt blob (502
  // blob_missing) — the member's only affordance was a broken button.
  const mainPdfKind: 'invoice' | 'combined' | 'receipt' =
    row.pdfDocKind === 'receipt_combined'
      ? 'combined'
      : row.pdfDocKind === 'receipt_separate'
        ? 'receipt'
        : 'invoice';

  // Combined-mode paid (bill-first): receipt reuses the invoice number (no
  // separate receipt number) AND the receipt PDF has finished rendering.
  // Applies ONLY when the main pdf is an issue-time stale draft — never to
  // as-paid rows whose main pdf is itself the combined document.
  const isCombinedPaid =
    row.status === 'paid' &&
    row.receiptDocumentNumberRaw === null &&
    row.receiptPdfStatus === 'rendered' &&
    mainPdfKind !== 'combined';

  const showInvoice = row.pdf !== null && !isCombinedPaid;

  // Gate the receipt action on the artifact it serves: the receipt BLOB.
  // (064 — 'rendered' alone is not enough; see the mainPdfKind note above.)
  const showReceipt =
    row.status === 'paid' &&
    row.receiptPdfStatus === 'rendered' &&
    row.receiptPdf !== null;

  // Paid invoice whose §105ทวิ receipt is GENUINELY mid-render — the
  // single non-terminal, non-rendered state (`receiptPdfStatus` enum is
  // 'pending' | 'rendered' | 'failed' | null). Narrowed to 'pending' ONLY
  // (S1 fix): a terminal 'failed' render must NOT show the "preparing"
  // spinner with aria-busy=true forever — it is reported by `receiptFailed`
  // below instead.
  const receiptPending = row.status === 'paid' && row.receiptPdfStatus === 'pending';

  // Paid invoice whose §105ทวิ receipt render TERMINALLY failed — the
  // terminal counterpart to `receiptPending`. Surfaces a static, non-busy
  // "Receipt unavailable" affordance (no spinner, no aria-busy).
  const receiptFailed = row.status === 'paid' && row.receiptPdfStatus === 'failed';

  const resendable = row.status !== 'void' && row.pdf !== null;

  // 064 remediation S3 — the printed §87/§105 number for display: the shared
  // Domain helper falls back to the §105 receipt number on β rows (NULL invoice
  // docnum) so surfaces never show an em-dash/UUID for a paid, numbered doc.
  // Hoisted so the 088 `primaryNumber` fallback can reuse it.
  const displayNumber = displayDocumentNumber(row);

  // 088 (T065 / T065a / FR-016) — the SC-bill ↔ RC-§86/4-tax-receipt
  // disambiguation, gated on the flag AND the row actually being a new-flow
  // bill (`billDocumentNumberRaw !== null`). A legacy separate-mode paid row
  // (§87 invoice number + RC, no bill number) is NOT an 088 two-document row
  // and stays `'none'` even with the flag on. The RC lives in
  // `receiptDocumentNumberRaw` (minted at payment) — its presence discriminates
  // a paid bill (`'tax_receipt'`) from an unpaid one (`'bill'`).
  const taxDocumentKind: InvoiceTaxDocumentKind = resolveTaxDocumentKind(
    row,
    taxAtPayment,
  );
  const billDocumentNumber =
    taxDocumentKind !== 'none' ? row.billDocumentNumberRaw : null;
  // 088 A-refined (FR-016) — an 088 invoice is ALWAYS identified by its OWN
  // (SC) bill number, consistently for PAID and UNPAID rows. The row identity
  // is therefore the SC bill for ANY 088 bill (`taxDocumentKind !== 'none'`) —
  // no longer the RC on a paid bill. The RC (§86/4 tax receipt) is surfaced
  // separately in the Receipt-No. column/line. Legacy rows keep `displayNumber`.
  const primaryNumber =
    taxDocumentKind !== 'none' ? billDocumentNumber : displayNumber;

  return {
    invoiceId: row.invoiceId,
    documentNumber: row.documentNumber?.raw ?? null,
    displayNumber,
    displayStatus,
    receiptNumber: row.receiptDocumentNumberRaw,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    total: row.total,
    isCombinedPaid,
    mainPdfKind,
    showInvoice,
    showReceipt,
    receiptPending,
    receiptFailed,
    resendable,
    taxDocumentKind,
    billDocumentNumber,
    primaryNumber,
  };
}
