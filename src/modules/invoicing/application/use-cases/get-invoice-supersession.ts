/**
 * 121-void-supersede-links — "what replaced this bill / what did it replace?"
 *
 * Read-only companion to the void-on-reissue supersede-void. Presentation (the
 * admin and portal invoice detail pages) calls this use-case; the audit-log
 * query lives behind `InvoiceSupersessionReadPort`.
 *
 * Which lookups run:
 *   - `void`   → forward (`replacedBy`) AND reverse (`replaces`): a replacement
 *                bill can itself be voided later and still name what it replaced.
 *   - `draft`  → nothing. A draft never superseded anything and is never a link
 *                target (the supersede-void runs only after the new bill issued).
 *   - other    → reverse only.
 *
 * Member scope (`restrictToMemberId`, the portal): the supersede-void only ever
 * links two bills of the SAME member (`listSupersedableMembershipBills` is keyed
 * on the member), so a link whose other end belongs to someone else is a data
 * anomaly. It is dropped — a member must never be handed a link to another
 * member's invoice — and logged at error level so it gets looked at. Staff scope
 * keeps it: staff can open either invoice anyway, and hiding it would hide the
 * anomaly.
 *
 * A failed read returns `read_failed` rather than an empty result: "we could not
 * look" is a different fact from "there is no link". Pages hide the row on
 * either, but only the failure is logged.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind, rootCause } from '@/lib/log-id';
import type { InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import type {
  InvoiceSupersessionReadPort,
  SupersessionLinkRow,
} from '../ports/invoice-supersession-port';

export interface GetInvoiceSupersessionDeps {
  readonly supersession: InvoiceSupersessionReadPort;
}

export interface GetInvoiceSupersessionInput {
  readonly tenantId: string;
  /** The invoice being viewed — already loaded (and ownership-checked) by the page. */
  readonly invoice: {
    readonly invoiceId: string;
    readonly status: InvoiceStatus;
    readonly memberId: string | null;
  };
  /** Portal: only return links whose other end belongs to this member. */
  readonly restrictToMemberId?: string;
}

export interface InvoiceSupersessionLink {
  readonly invoiceId: string;
  /** Bill / document number; the invoice id when the other end has none. */
  readonly displayNumber: string;
  readonly issueDate: string | null;
}

export interface InvoiceSupersession {
  /** Set only on a supersede-voided invoice. */
  readonly replacedBy: InvoiceSupersessionLink | null;
  /** The bills this invoice superseded (oldest first); usually empty. */
  readonly replaces: readonly InvoiceSupersessionLink[];
}

export interface InvoiceSupersessionReadFailed {
  readonly code: 'read_failed';
}

export async function getInvoiceSupersession(
  deps: GetInvoiceSupersessionDeps,
  input: GetInvoiceSupersessionInput,
): Promise<Result<InvoiceSupersession, InvoiceSupersessionReadFailed>> {
  const { invoice } = input;
  if (invoice.status === 'draft') return ok({ replacedBy: null, replaces: [] });

  let forward: SupersessionLinkRow | null;
  let reverse: readonly SupersessionLinkRow[];
  try {
    [forward, reverse] = await Promise.all([
      invoice.status === 'void'
        ? deps.supersession.findReplacement(input.tenantId, invoice.invoiceId)
        : Promise.resolve(null),
      deps.supersession.findReplaced(input.tenantId, invoice.invoiceId),
    ]);
  } catch (e) {
    logger.warn(
      { tenantId: input.tenantId, invoiceId: invoice.invoiceId, err: errKind(rootCause(e)) },
      'getInvoiceSupersession: supersede-link read failed — link hidden',
    );
    return err({ code: 'read_failed' });
  }

  const visible = (row: SupersessionLinkRow): boolean => {
    if (row.status === 'draft') return false;
    if (
      input.restrictToMemberId !== undefined &&
      row.memberId !== input.restrictToMemberId
    ) {
      logger.error(
        {
          tenantId: input.tenantId,
          invoiceId: invoice.invoiceId,
          linkedInvoiceId: row.invoiceId,
        },
        'getInvoiceSupersession: supersede link member mismatch — link dropped for member scope',
      );
      return false;
    }
    return true;
  };

  return ok({
    replacedBy: forward !== null && visible(forward) ? toLink(forward) : null,
    replaces: reverse.filter(visible).map(toLink),
  });
}

function toLink(row: SupersessionLinkRow): InvoiceSupersessionLink {
  return {
    invoiceId: row.invoiceId,
    displayNumber: row.displayNumber ?? row.invoiceId,
    issueDate: row.issueDate,
  };
}
