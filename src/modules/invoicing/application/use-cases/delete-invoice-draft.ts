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
  readonly requestId?: string | null;
  readonly invoiceId: string;
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
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Probe on invoice ${invoiceId} (not found on draft delete)`,
        payload: {
          attempted_invoice_id: invoiceId,
          actor_role: 'admin',
          route: 'delete-invoice-draft',
        },
      });
      return err({ code: 'invoice_not_found' });
    }
    if (row.status !== 'draft') return err({ code: 'not_draft' });
    await deps.invoiceRepo.deleteDraft(tx, invoiceId, input.tenantId);
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
