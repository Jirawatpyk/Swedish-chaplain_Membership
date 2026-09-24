/**
 * 106-void-on-reissue follow-up — `supersede_issues` → i18n routing (pure).
 *
 * Every route that issues a membership bill through the renewal bridge
 * (`/issue-auto-drafted`, `/admin/members/[id]/renew`) reports each
 * best-effort supersede-void failure as a structured
 * `{ kind, invoice_id?, bill_document_number?, error_code? }` entry
 * (`src/lib/supersede-issues-wire.ts`); this leaf turns them into message
 * keys under `admin.invoices.supersedeWarning.` so the toast never shows a
 * server string or an internal UUID.
 *
 * Fail-closed: the body is untrusted JSON, so a malformed entry, an unknown
 * `kind`, or a response carrying only the deprecated `supersede_warnings`
 * string array still yields the generic `listFailed` copy ("check this
 * member's older bills") rather than nothing — silently dropping the warning
 * would leave a duplicate bill open with no one told.
 *
 * Pure `.ts` leaf (no React import graph), mirroring
 * `issue-auto-draft-error-routing.ts`.
 */

export type SupersedeIssueCopy =
  | { readonly messageKey: 'listFailed' }
  | {
      readonly messageKey: 'voidFailed';
      /** Link target (`/admin/invoices/{invoiceId}`) — never displayed. */
      readonly invoiceId: string;
      /** The old bill's printed `SC` number, shown to staff. */
      readonly number: string;
    };

type WireSupersedeIssue =
  | { readonly kind: 'list_failed' }
  | {
      readonly kind: 'void_failed' | 'void_threw';
      readonly invoice_id: string;
      readonly bill_document_number: string;
    };

const GENERIC: SupersedeIssueCopy = { messageKey: 'listFailed' };

function parseIssue(raw: unknown): WireSupersedeIssue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (entry['kind'] === 'list_failed') return { kind: 'list_failed' };
  if (
    (entry['kind'] === 'void_failed' || entry['kind'] === 'void_threw') &&
    typeof entry['invoice_id'] === 'string' &&
    entry['invoice_id'] !== '' &&
    typeof entry['bill_document_number'] === 'string' &&
    entry['bill_document_number'] !== ''
  ) {
    return {
      kind: entry['kind'],
      invoice_id: entry['invoice_id'],
      bill_document_number: entry['bill_document_number'],
    };
  }
  return null;
}

function routeIssue(issue: WireSupersedeIssue): SupersedeIssueCopy {
  switch (issue.kind) {
    case 'list_failed':
      return GENERIC;
    case 'void_failed':
    case 'void_threw':
      // Same action for staff either way: the old bill is still open and
      // must be voided by hand.
      return {
        messageKey: 'voidFailed',
        invoiceId: issue.invoice_id,
        number: issue.bill_document_number,
      };
    default: {
      const _exhaustive: never = issue;
      void _exhaustive;
      return GENERIC;
    }
  }
}

export function routeSupersedeIssues(body: {
  readonly supersede_issues?: unknown;
  readonly supersede_warnings?: unknown;
}): readonly SupersedeIssueCopy[] {
  const issues = body.supersede_issues;
  if (!Array.isArray(issues)) {
    const legacy = body.supersede_warnings;
    return Array.isArray(legacy) && legacy.length > 0 ? [GENERIC] : [];
  }
  const routed: SupersedeIssueCopy[] = [];
  for (const raw of issues) {
    const parsed = parseIssue(raw);
    const copy = parsed === null ? GENERIC : routeIssue(parsed);
    // One generic line is enough, however many entries degraded to it.
    if (copy.messageKey === 'listFailed' && routed.some((c) => c.messageKey === 'listFailed')) {
      continue;
    }
    routed.push(copy);
  }
  return routed;
}
