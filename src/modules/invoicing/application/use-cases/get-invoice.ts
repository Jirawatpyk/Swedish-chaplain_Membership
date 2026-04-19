/**
 * get-invoice use case (F4) — loads an invoice by id for the current
 * tenant. Used by admin detail + member-portal detail routes.
 *
 * Emits `invoice_cross_tenant_probe` on not-found when actor context
 * is provided (Constitution Principle I clause 3 — app-layer audit
 * on cross-tenant access attempts). RLS at the DB layer already
 * blocks the read; this audit surfaces the attempt so SOC can
 * correlate probes with IP / session.
 *
 * The audit emit is OPTIONAL — if caller omits `actor` context we
 * skip the emit (e.g. internal reconciliation reads that aren't
 * tied to a user session). The PDF signed-url path uses its own
 * specialised use case `get-invoice-pdf-signed-url` which always
 * has actor context.
 */
import { ok, err, type Result } from '@/lib/result';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { AuditPort } from '../ports/audit-port';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';

export interface GetInvoiceInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  /**
   * Actor context — when present, not-found paths emit
   * `invoice_cross_tenant_probe`. Admin/manager detail routes MUST
   * supply this; background jobs that read without a user session
   * may omit it.
   */
  readonly actor?: {
    readonly userId: string;
    readonly role: 'admin' | 'manager' | 'member';
    readonly requestId: string | null;
  };
}

export type GetInvoiceError = { code: 'not_found' };

export interface GetInvoiceDeps {
  readonly invoiceRepo: InvoiceRepo;
  /**
   * Optional — when present, probe audits fire on not-found. Deps
   * factory wires this for the admin/portal detail routes; callers
   * who never supply `actor` in the input can safely pass `undefined`.
   */
  readonly audit?: AuditPort;
}

export async function getInvoice(
  deps: GetInvoiceDeps,
  input: GetInvoiceInput,
): Promise<Result<Invoice, GetInvoiceError>> {
  const invoice = await deps.invoiceRepo.findById(asInvoiceId(input.invoiceId), input.tenantId);
  if (!invoice) {
    if (input.actor && deps.audit) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.actor.requestId,
        eventType: 'invoice_cross_tenant_probe',
        actorUserId: input.actor.userId,
        summary: `Probe on invoice ${input.invoiceId} (not found in actor tenant)`,
        payload: {
          attempted_invoice_id: input.invoiceId,
          actor_role: input.actor.role,
          route: 'get-invoice',
        },
      });
    }
    return err({ code: 'not_found' });
  }
  return ok(invoice);
}
