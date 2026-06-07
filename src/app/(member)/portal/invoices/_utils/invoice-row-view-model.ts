/**
 * 060-member-portal-d4 — Shared per-row view-model for the member-portal
 * invoice LIST.
 *
 * Single source of truth for the per-row presentation flags that the
 * desktop `<table>` and the upcoming mobile card list both render. Both
 * surfaces MUST consume `toInvoiceRowViewModel(...)` so they can never
 * drift apart (a flag fixed for the table is fixed for the card, and
 * vice versa).
 *
 * PURITY CONTRACT (project convention — avoid impure time in testable
 * units): this function NEVER calls `new Date()` / `Date.now()`. The
 * caller passes `nowUtcIso` (the same `new Date().toISOString()` the
 * list page already computes once per render) so the overdue derivation
 * is deterministic and unit-testable at boundaries. Mirrors how
 * `page.tsx` derives `displayStatus` via `computeIsOverdue(r, nowUtcIso)`.
 *
 * The flag logic below is a BYTE-FOR-BYTE extraction of the inline
 * expressions that previously lived in `page.tsx`'s `<TableBody>` row
 * map — do not "improve" the boolean conditions; the desktop table's
 * rendered output must stay identical.
 *
 * i18n decision (for the upcoming mobile card): NO new keys added. The
 * existing column labels already read as inline card labels — EN
 * `portal.invoices.columns.issueDate` = "Issued" and `columns.dueDate`
 * = "Due" (TH "วันที่ออก"/"ครบกำหนด", SV "Utfärdad"/"Förfaller"). Adding
 * `card.issued`/`card.due` would duplicate identical values (Principle X
 * — Simplicity; Reusable Components). The card reuses the column keys.
 */
import type { Invoice, InvoiceStatus } from '@/modules/invoicing';
import { computeIsOverdue } from '@/modules/invoicing';
import type { Money } from '@/modules/invoicing';

/**
 * Presentation status surfaced to the row — the stored {@link InvoiceStatus}
 * widened with the derived `'overdue'` value (T109 / FR-028). `'overdue'`
 * is presentation-only; the stored status is never `'overdue'`.
 */
export type InvoiceRowDisplayStatus = InvoiceStatus | 'overdue';

/**
 * Everything a single invoice list row needs to render, computed once
 * and shared by the desktop table + mobile card. Raw document/receipt
 * numbers are kept as `string | null` (callers apply the `?? '—'` /
 * `?? invoiceId` fallbacks they already use for aria labels + display).
 */
export interface InvoiceRowViewModel {
  readonly invoiceId: Invoice['invoiceId'];
  /** Raw invoice document number (e.g. `INV-2026-000001`), null on draft. */
  readonly documentNumber: string | null;
  /** Presentation status (issued → overdue swap applied — T109 / FR-028). */
  readonly displayStatus: InvoiceRowDisplayStatus;
  /** Raw separate-mode receipt document number; null in combined-mode. */
  readonly receiptNumber: string | null;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly total: Money | null;
  /**
   * Combined-mode paid invoice: the invoice PDF *is* the receipt (no
   * separate receipt number) and its receipt PDF has finished rendering.
   * When true the table/card hides the (stale) invoice anchor and shows
   * only the combined Receipt download.
   */
  readonly isCombinedPaid: boolean;
  /** Show the invoice-PDF download (PDF exists and it is not combined-paid). */
  readonly showInvoice: boolean;
  /** Show the receipt-PDF download (paid + receipt PDF rendered). */
  readonly showReceipt: boolean;
  /** Paid invoice whose receipt PDF is still rendering (pending/failed). */
  readonly receiptPending: boolean;
  /** Resend the invoice email (not void + invoice PDF exists). */
  readonly resendable: boolean;
  /**
   * Whether the row has ANY document/action to render in its action cell
   * — the OR of the four action flags. When false there is nothing to
   * download or do, so both the desktop table cell AND the mobile card
   * render the em-dash sentinel `—` instead of an (empty) action group.
   *
   * Equivalent to the table's former `r.pdf === null` proxy: every action
   * flag (`showInvoice`/`resendable`) is gated on `row.pdf !== null`, and
   * `showReceipt`/`receiptPending` only fire on `paid` rows (which always
   * carry a receipt PDF), so `hasAnyAction === false` ⟺ the issue-time
   * invoice PDF is absent (draft-shape / unrendered issued row). A void
   * invoice that still has its PDF keeps `hasAnyAction === true` via
   * `showInvoice` (the voided-invoice download stays available).
   */
  readonly hasAnyAction: boolean;
}

/**
 * Pure mapper. `nowUtcIso` MUST be supplied by the caller (do NOT call
 * `new Date()` here) so overdue derivation stays deterministic and the
 * view-model is testable at boundaries.
 *
 * Boolean logic is a verbatim copy of the former inline expressions in
 * `page.tsx` — see the per-flag comments for the original source lines.
 */
export function toInvoiceRowViewModel(
  row: Invoice,
  nowUtcIso: string,
): InvoiceRowViewModel {
  // T109 / FR-028 — `'issued'` swaps to `'overdue'` once Bangkok-today
  // has passed dueDate; every other stored status passes through.
  const displayStatus: InvoiceRowDisplayStatus = computeIsOverdue(row, nowUtcIso)
    ? 'overdue'
    : row.status;

  // Combined-mode paid: receipt reuses the invoice number (no separate
  // receipt number) AND the receipt PDF has finished rendering.
  const isCombinedPaid =
    row.status === 'paid' &&
    row.receiptDocumentNumberRaw === null &&
    row.receiptPdfStatus === 'rendered';

  const showInvoice = row.pdf !== null && !isCombinedPaid;

  const showReceipt = row.status === 'paid' && row.receiptPdfStatus === 'rendered';

  // Paid invoice whose §105ทวิ receipt is mid-render (pending/failed),
  // i.e. receiptPdfStatus is set but not yet 'rendered'.
  const receiptPending =
    row.status === 'paid' &&
    row.receiptPdfStatus !== null &&
    row.receiptPdfStatus !== 'rendered';

  const resendable = row.status !== 'void' && row.pdf !== null;

  // True iff the row has any document/action to surface. Mirrors the OR
  // the desktop action cell + mobile card both branch on to decide between
  // rendering the action group and the em-dash sentinel — see the field
  // doc on `InvoiceRowViewModel.hasAnyAction`.
  const hasAnyAction = showInvoice || showReceipt || receiptPending || resendable;

  return {
    invoiceId: row.invoiceId,
    documentNumber: row.documentNumber?.raw ?? null,
    displayStatus,
    receiptNumber: row.receiptDocumentNumberRaw,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    total: row.total,
    isCombinedPaid,
    showInvoice,
    showReceipt,
    receiptPending,
    resendable,
    hasAnyAction,
  };
}
