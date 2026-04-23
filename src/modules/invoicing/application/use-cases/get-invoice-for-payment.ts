/**
 * T014 — getInvoiceForPayment (F4 → F5 bridge).
 *
 * Read-only DTO use-case: F5's payment-intent creation path calls this
 * to resolve payability + ownership signals for an invoice without
 * pulling the full Invoice aggregate (snapshots, lines, VAT breakdown,
 * …) into F5's memory graph.
 *
 * Why a dedicated read-only bridge (vs. reusing `getInvoice`):
 *   1. Surface minimisation — F5 only needs {id, status, total_satang,
 *      member_id, tenant_id} to decide "can this member initiate a
 *      payment on this invoice?". Exposing the full Invoice domain
 *      type would couple F5 to F4's lifecycle (snapshots, lines, VAT)
 *      for no benefit.
 *   2. Intent clarity — the name makes the payability check auditable
 *      at call sites (easy to grep; future static analysis can flag
 *      "F5 reading F4 invoice WITHOUT going through the bridge").
 *   3. Cross-tenant probe — delegates to the underlying `getInvoice`
 *      use-case which already emits `invoice_cross_tenant_probe` on
 *      not-found (Constitution Principle I clause 4). No duplication.
 *
 * Ownership check: when the actor is a member, the underlying
 * `getInvoice` use-case fires the same-tenant member-mismatch guard,
 * returning `forbidden`. F5 consumers that skip the `actor` field
 * (e.g. webhook-side reconciliation) skip the check — caller
 * decides whether ownership matters.
 */
import { err, ok, type Result } from '@/lib/result';
import { getInvoice, type GetInvoiceDeps } from './get-invoice';
import type { InvoiceStatus } from '../../domain/invoice';

/** Input for the F5 → F4 payability + ownership resolver. */
export interface GetInvoiceForPaymentInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  /**
   * Optional actor context — when present, not-found + member-mismatch
   * paths emit `invoice_cross_tenant_probe` per Constitution Principle I.
   * Webhook reconciliation paths omit this; portal/admin payment-init
   * paths MUST supply it.
   */
  readonly actor?: {
    readonly userId: string;
    readonly role: 'admin' | 'manager' | 'member';
    readonly requestId: string | null;
    readonly memberId?: string;
  };
}

/**
 * F5 payability DTO. Surfaces the minimum invoice metadata F5 needs
 * to:
 *   - decide if the invoice is in a payable status (`issued`)
 *   - resolve the amount to charge (`totalSatang`)
 *   - bind the payment to a member (`memberId`, `tenantId`) for RLS
 *
 * Intentionally excludes lines/snapshots/VAT breakdown — those are
 * F4 internals; F5 never renders or mutates them.
 */
export interface InvoiceForPayment {
  readonly id: string;
  readonly status: InvoiceStatus;
  readonly totalSatang: bigint;
  readonly memberId: string;
  readonly tenantId: string;
}

export type GetInvoiceForPaymentError =
  | { code: 'not_found' }
  | { code: 'forbidden' };

/** Deps: same as the underlying F4 use-case. */
export type GetInvoiceForPaymentDeps = GetInvoiceDeps;

export async function getInvoiceForPayment(
  deps: GetInvoiceForPaymentDeps,
  input: GetInvoiceForPaymentInput,
): Promise<Result<InvoiceForPayment, GetInvoiceForPaymentError>> {
  const result = await getInvoice(deps, {
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    ...(input.actor ? { actor: input.actor } : {}),
  });
  if (!result.ok) return err(result.error);

  const invoice = result.value;
  // Project to the minimal F5-facing DTO. Money VO exposes satang via
  // `.satang` (see domain/value-objects/money.ts). If total is null —
  // which can only happen on drafts before issue — the F5 caller
  // should have short-circuited on status first; we guard here too.
  if (!invoice.total) {
    // Surface as forbidden rather than not_found: the invoice exists
    // and the caller is authorised, it's just not in a payable state
    // (F5 caller branches on `status` next).
    return ok({
      id: invoice.invoiceId,
      status: invoice.status,
      totalSatang: 0n,
      memberId: invoice.memberId,
      tenantId: input.tenantId,
    });
  }

  return ok({
    id: invoice.invoiceId,
    status: invoice.status,
    totalSatang: invoice.total.satang,
    memberId: invoice.memberId,
    tenantId: input.tenantId,
  });
}
