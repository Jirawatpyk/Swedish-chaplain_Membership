/**
 * T035 — delete-invoice-draft use case (F4).
 * Hard delete — only permitted on `draft` status (DB CHECK already
 * rejects deletes on non-draft via the composite FK cascade rules).
 */
import { err, ok, type Result } from '@/lib/result';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { AuditPort } from '../ports/audit-port';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';

export interface DeleteInvoiceDraftInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  /**
   * 017 actor-role truth sweep — the LITERAL staff role the invoicing gate
   * admits. Stamped into the cross-tenant probe payload below; a hardcoded
   * 'admin' misattributed every post-Migration-C actor in that forensic
   * trail. Reaches here from the admin DELETE route and from the renewals
   * auto-draft discard bridge, both admin-tier.
   */
  readonly actorRole?: 'admin' | 'super_admin';
  readonly requestId?: string | null;
  readonly invoiceId: string;
  /**
   * 107-auto-invoice Task 9 — suppress the not-found `invoice_cross_tenant_probe`
   * audit emit for callers that legitimately race with the row's disappearance.
   *
   * That event is a cross-tenant INTRUSION signal wired to alerting: it means
   * "someone referenced an invoice id they have no rights to". A sweep that
   * enumerated ids from the tenant's OWN data and then deletes them one by one
   * routinely loses that race (a concurrent issue, Task 11's prune cron, or a
   * manual discard removes a row between the scan and the delete) — emitting
   * the probe event there would flood the signal with self-inflicted noise and
   * destroy its value as an alert.
   *
   * Set ONLY when the id provably came from a tenant-scoped read in the same
   * logical operation. Never set it for an id sourced from a request body —
   * that is exactly the case the probe event exists to catch.
   */
  readonly expectMayHaveVanished?: boolean;
}

export type DeleteInvoiceDraftError =
  | { code: 'invoice_not_found' }
  | { code: 'not_draft' };

export interface DeleteInvoiceDraftDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly audit: AuditPort;
}

export async function deleteInvoiceDraft(
  deps: DeleteInvoiceDraftDeps,
  input: DeleteInvoiceDraftInput,
): Promise<Result<void, DeleteInvoiceDraftError>> {
  const invoiceId = asInvoiceId(input.invoiceId);
  return deps.invoiceRepo.withTx(async (tx) => {
    const row = await deps.invoiceRepo.findByIdInTx(tx, invoiceId, input.tenantId);
    if (!row) {
      // R7-W1 — probe on not-found (RLS-hidden vs. truly-missing is
      // indistinguishable from the app side; audit either way per
      // Constitution Principle I clause 4).
      //
      // …EXCEPT for a caller that enumerated this id from its own
      // tenant-scoped read and is racing the row's disappearance — see
      // `expectMayHaveVanished`. Emitting there would pollute an intrusion
      // signal with self-inflicted noise.
      if (input.expectMayHaveVanished === true) {
        return err({ code: 'invoice_not_found' });
      }
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Probe on invoice ${invoiceId} (not found on draft delete)`,
        payload: {
          attempted_invoice_id: invoiceId,
          actor_role: input.actorRole ?? null,
          route: 'delete-invoice-draft',
        },
      });
      return err({ code: 'invoice_not_found' });
    }
    if (row.status !== 'draft') return err({ code: 'not_draft' });
    // The repo's DELETE re-asserts `status = 'draft'` in the statement, so a
    // concurrent issue that promoted the row between the read above and this
    // call deletes NOTHING and reports `false` — surface that as `not_draft`
    // (the same answer the pre-check would have given had it seen the newer
    // snapshot) instead of reporting a delete that never happened.
    const deleted = await deps.invoiceRepo.deleteDraft(tx, invoiceId, input.tenantId);
    if (!deleted) return err({ code: 'not_draft' });
    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'invoice_draft_deleted',
      actorUserId: input.actorUserId,
      summary: `Draft invoice deleted`,
      payload: { invoice_id: invoiceId },
    });
    return ok(undefined);
  });
}
