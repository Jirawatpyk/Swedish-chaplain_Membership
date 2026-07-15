/**
 * Wave-4 S19 — canonical error-code list for `issueEventInvoiceAsPaid`.
 *
 * Lives in its own LEAF module (type-only import of the error union) so a
 * client component can consume the runtime array without dragging the
 * use-case's runtime graph (pino logger, node crypto, metrics) into the
 * client bundle — the sibling use-case file is server-only in practice.
 *
 * Exhaustiveness is enforced TWO-WAY at compile time by the
 * `satisfies Record<code, true>` on the flag map below:
 *   - a NEW error variant whose code is missing here fails to compile
 *     (missing property), and
 *   - a typo'd / removed code fails as an excess property.
 * The exported array is derived from that map, so it can never drift from
 * the union.
 */
import type { IssueEventInvoiceAsPaidError } from './issue-event-invoice-as-paid';

type IssueEventInvoiceAsPaidErrorCode = IssueEventInvoiceAsPaidError['code'];

const ISSUE_EVENT_INVOICE_AS_PAID_ERROR_CODE_FLAGS = {
  invoice_not_found: true,
  not_event_subject: true,
  invoice_already_issued: true,
  settings_missing: true,
  member_not_found: true,
  member_archived: true,
  no_buyer_snapshot: true,
  payment_date_future: true,
  payment_date_too_old: true,
  registration_refunded: true,
  registration_lookup_failed: true,
  invalid_lines: true,
  overflow: true,
  pdf_render_failed: true,
  blob_upload_failed: true,
  // 059 PR-A Task 4 fix — VAT-registrant buyer with no tax_id (Domain VO
  // write-time invariant).
  buyer_tax_id_required_for_registrant: true,
} as const satisfies Record<IssueEventInvoiceAsPaidErrorCode, true>;

/** Every `IssueEventInvoiceAsPaidError['code']`, exactly once. */
export const ISSUE_EVENT_INVOICE_AS_PAID_ERROR_CODES = Object.keys(
  ISSUE_EVENT_INVOICE_AS_PAID_ERROR_CODE_FLAGS,
) as readonly IssueEventInvoiceAsPaidErrorCode[];
