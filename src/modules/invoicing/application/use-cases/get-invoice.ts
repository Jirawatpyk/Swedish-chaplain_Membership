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
   *
   * When `role === 'member'` and `memberId` is supplied, an
   * additional **same-tenant member-mismatch** check fires: if the
   * resolved invoice belongs to a sibling member inside the same
   * chamber, the use case emits `invoice_cross_tenant_probe` with
   * the mismatch payload AND returns `forbidden`. Mirrors the guard
   * inside `get-invoice-pdf-signed-url` so the detail-page surface
   * cannot be used to enumerate sibling-member invoice ids.
   */
  readonly actor?: {
    readonly userId: string;
    readonly role: 'admin' | 'manager' | 'member';
    readonly requestId: string | null;
    readonly memberId?: string;
  };
}

export type GetInvoiceError =
  | { code: 'not_found' }
  | { code: 'forbidden' };

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

  // Same-tenant, different-member guard for member-role callers.
  if (
    input.actor?.role === 'member' &&
    input.actor.memberId !== undefined &&
    invoice.memberId !== input.actor.memberId
  ) {
    if (deps.audit) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.actor.requestId,
        eventType: 'invoice_cross_tenant_probe',
        actorUserId: input.actor.userId,
        summary: `Member probe on non-owned invoice ${input.invoiceId}`,
        payload: {
          attempted_invoice_id: input.invoiceId,
          actor_role: 'member',
          actor_member_id: input.actor.memberId,
          invoice_member_id: invoice.memberId,
          route: 'get-invoice',
        },
      });
    }
    return err({ code: 'forbidden' });
  }

  return ok(invoice);
}
