/**
 * Resolve F4 audit event types to F3 timeline i18n keys — US7 AS2.
 *
 * Pure mapper — no framework, DB, or HTTP deps — lives in the
 * Application layer so Domain 100% line coverage applies. The F3
 * timeline component (US6) consumes this to render bespoke F4 copy
 * ("Issued invoice INV-2026-0042") instead of a generic event type.
 *
 * Phase-9 invariant: the `invoice_voided` link `/admin/invoices/<id>`
 * assumes the void operation PRESERVES the invoice row (only sets
 * `status=void` + re-renders the PDF with the overlay, per spec FR-008).
 * Hard-deleting the invoice row on void would turn every historical
 * timeline link into a 404. Spec § User Story 5 / Phase 9 MUST keep
 * the row intact.
 */
import {
  F4_MEMBER_TIMELINE_EVENT_TYPES,
  type F4MemberTimelineEventType,
} from '@/modules/invoicing';

export interface InvoiceEventCopy {
  /** i18n key relative to `admin.members.timeline.`. */
  readonly i18nKey: string;
  /** Variables passed to `next-intl`'s `t()` for interpolation. */
  readonly vars: Record<string, string | number>;
  /** Deep-link to the related F4 document; `null` when unresolvable. */
  readonly link: string | null;
}

interface AuditPayloadLike {
  readonly invoice_id?: string;
  readonly credit_note_id?: string;
  readonly document_number?: string;
  /**
   * 088 (FR-030) — the SC bill number of an issued 088 ใบแจ้งหนี้, whose §87
   * `document_number` is NULL until payment. The `invoice_issued` audit event
   * emits it (issue-invoice.ts). Without this fallback the timeline renders
   * `invoiceIssued` with a MISSING {documentNumber} for every 088 bill.
   */
  readonly bill_document_number_raw?: string;
  readonly receipt_document_number?: string;
  /**
   * 088 (FR-029) — the §87 `RC` tax-receipt number, carried by the
   * `tax_receipt_issued` audit event (record-payment.ts emit payload). Distinct
   * key from the older `receipt_document_number`; both are accepted so the copy
   * resolves regardless of which emit site produced the row.
   */
  readonly receipt_document_number_raw?: string;
  readonly payment_method?: string;
  readonly total_satang?: string | number;
  readonly credit_amount_satang?: string | number;
  readonly reason?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function resolveInvoiceEventCopy(
  eventType: string,
  payload: Record<string, unknown> | null,
): InvoiceEventCopy | null {
  if (
    !(F4_MEMBER_TIMELINE_EVENT_TYPES as readonly string[]).includes(eventType)
  ) {
    return null;
  }
  const p = (payload ?? {}) as AuditPayloadLike;
  const invoiceId = str(p.invoice_id);
  const creditNoteId = str(p.credit_note_id);
  const docNum =
    str(p.document_number) ??
    str(p.bill_document_number_raw) ??
    str(p.receipt_document_number) ??
    str(p.receipt_document_number_raw);

  const linkForInvoice = invoiceId ? `/admin/invoices/${invoiceId}` : null;
  const linkForCreditNote = creditNoteId
    ? `/admin/credit-notes/${creditNoteId}`
    : null;

  const vars: Record<string, string | number> = {};
  if (docNum) vars.documentNumber = docNum;
  if (p.total_satang !== undefined) {
    vars.totalSatang = String(p.total_satang);
  }
  if (p.credit_amount_satang !== undefined) {
    vars.creditAmountSatang = String(p.credit_amount_satang);
    // G-6 — also emit a pre-divided decimal form so locale copy can
    // interpolate a human-readable amount (e.g. "107.00") without
    // coupling this pure resolver to a locale-aware formatter. Uses
    // deterministic two-decimal division with no thousands grouping;
    // locale-specific grouping is a consumer concern.
    try {
      const satang = BigInt(p.credit_amount_satang as string);
      const abs = satang < 0n ? -satang : satang;
      const whole = abs / 100n;
      const rem = abs % 100n;
      const sign = satang < 0n ? '-' : '';
      vars.creditAmount = `${sign}${whole.toString()}.${rem.toString().padStart(2, '0')}`;
    } catch {
      /* non-coercible input — leave `creditAmount` unset so the copy
       * falls back to {creditAmount} placeholder; tests cover both. */
    }
  }
  if (p.payment_method) vars.paymentMethod = p.payment_method;
  if (p.reason) vars.reason = p.reason;

  const keyByType: Record<F4MemberTimelineEventType, string> = {
    invoice_draft_created: 'invoiceDraftCreated',
    invoice_issued: 'invoiceIssued',
    invoice_paid: 'invoicePaid',
    invoice_voided: 'invoiceVoided',
    credit_note_issued: 'creditNoteIssued',
    invoice_pdf_resent: 'invoicePdfResent',
    // 088 (FR-029) — §86/4 tax receipt minted at payment; interpolates the
    // `RC-…` number (from `receipt_document_number_raw`) + links the document.
    tax_receipt_issued: 'taxReceiptIssued',
  };

  const key = keyByType[eventType as F4MemberTimelineEventType];
  const link =
    eventType === 'credit_note_issued' ? linkForCreditNote : linkForInvoice;

  return { i18nKey: key, vars, link };
}
