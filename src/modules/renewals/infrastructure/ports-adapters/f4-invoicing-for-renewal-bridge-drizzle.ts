/**
 * F8 Phase 5 Wave C → Production · `F4InvoicingForRenewalBridge`.
 *
 * Composes F4's `createInvoiceDraft` + `issueInvoice` use-cases via
 * the F4 barrel exports. Used by the T122 confirm-renewal use-case.
 *
 * Atomicity: each F4 call opens its own internal `withTx` transaction.
 * `createInvoiceDraft` commits BEFORE `issueInvoice` runs (it must — the
 * draft row is the issue target). If `issueInvoice` fails AFTER
 * createDraft committed, an orphan `draft` invoice exists in F4. The
 * F8 use-case (T122) handles this trade-off via the
 * `invoice_creation_failed` error variant + downstream admin recovery.
 *
 * Pure Infrastructure — only F4 barrel imports + the port interface.
 */
import {
  createInvoiceDraft,
  issueInvoice,
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
} from '@/modules/invoicing';
import type {
  F4InvoicingForRenewalBridge,
  IssueInvoiceForRenewalInput,
  IssueInvoiceForRenewalResult,
} from '../../application/ports/f4-invoicing-bridge';

export const f4InvoicingForRenewalBridge: F4InvoicingForRenewalBridge = {
  async issueInvoiceForRenewal(
    input: IssueInvoiceForRenewalInput,
  ): Promise<IssueInvoiceForRenewalResult> {
    // ---- Step 1: createInvoiceDraft (own internal tx, commits standalone)
    const createResult = await createInvoiceDraft(
      makeCreateInvoiceDraftDeps(input.tenantId),
      {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        memberId: input.memberId,
        planId: input.planId,
        planYear: input.planYear,
        autoEmailOnIssue: input.autoEmailOnIssue,
      },
    );
    if (!createResult.ok) {
      return {
        status: 'create_failed',
        errorCode: createResult.error.code,
        detail:
          'reason' in createResult.error
            ? String(createResult.error.reason)
            : createResult.error.code,
      };
    }
    const draft = createResult.value;

    // ---- Step 2: issueInvoice — promotes draft → issued. Allocates
    // §87 sequence number, renders bilingual PDF, uploads to Vercel Blob.
    const issueResult = await issueInvoice(
      makeIssueInvoiceDeps(input.tenantId),
      {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        invoiceId: draft.invoiceId,
      },
    );
    if (!issueResult.ok) {
      return {
        status: 'issue_failed',
        errorCode: issueResult.error.code,
        detail:
          'reason' in issueResult.error
            ? String(issueResult.error.reason)
            : issueResult.error.code,
      };
    }
    const issued = issueResult.value;

    // documentNumber + total are non-null after `issued` per F4's
    // status-discriminated invariant. Defensive nullish coalescing
    // just in case the upstream type widens.
    const totalSatang =
      issued.total !== null ? BigInt(issued.total.satang) : 0n;
    const invoiceNumber =
      issued.documentNumber !== null ? String(issued.documentNumber) : '';
    return {
      status: 'issued',
      invoiceId: issued.invoiceId,
      invoiceNumber,
      totalSatang,
    };
  },
};
