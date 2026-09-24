/**
 * 106-void-on-reissue follow-up — HTTP wire shape for the typed
 * `SupersedeWarning`s F4's `issueMembershipBill` returns when it could not
 * auto-void a member's older unpaid bill. Shared by every route that issues a
 * membership bill through the renewal bridge (`/issue-auto-drafted`,
 * `/admin/members/[id]/renew`), so the admin UI parses ONE contract.
 */
import type { SupersedeWarning } from '@/modules/invoicing';

/**
 * 106-void-on-reissue follow-up — wire shape of one supersede-void failure
 * (`supersede_issues[]`). Structured, never prose: the admin UI translates
 * each `kind` and names the old bill by `bill_document_number` (its printed
 * `SC` number), linking to it via `invoice_id`. `error_code` is the closed
 * `VoidInvoiceError` code, forwarded for diagnostics only.
 *
 * An unknown kind (a variant added upstream without updating this switch)
 * degrades to `list_failed` — "check this member's older bills by hand" —
 * rather than being dropped: under-reporting a still-open duplicate bill is
 * the unsafe direction.
 */
export function serialiseSupersedeIssue(warning: SupersedeWarning): Record<string, unknown> {
  switch (warning.kind) {
    case 'list_failed':
      return { kind: warning.kind };
    case 'void_failed':
      return {
        kind: warning.kind,
        invoice_id: warning.invoiceId,
        bill_document_number: warning.billDocumentNumber,
        error_code: warning.errorCode,
      };
    case 'void_threw':
      return {
        kind: warning.kind,
        invoice_id: warning.invoiceId,
        bill_document_number: warning.billDocumentNumber,
      };
    default: {
      const _exhaustive: never = warning;
      void _exhaustive;
      return { kind: 'list_failed' };
    }
  }
}
