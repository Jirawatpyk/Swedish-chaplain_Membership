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
import { asSatang, type Satang } from '@/lib/money';
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
 *   - bind the payment to its tenant + invoice (`tenantId`, `id`)
 *
 * `memberId` is `string | null` (054-event-fee-invoices Task 8). A payment
 * binds primarily to (tenant, invoice); the member binding is OPTIONAL — it
 * is null for NON-member event-fee invoices (`invoice_subject='event'` with
 * `member_id IS NULL`). Online self-pay through F5 currently requires a
 * member binding (F5's `payments.member_id` is NOT NULL), so the use-case
 * below rejects null-member invoices with a typed `not_payable` BEFORE
 * constructing an `ok` DTO — i.e. on the `ok` path this field is always a
 * real id, but the TYPE is honest so other readers (admin / credit-note /
 * future buyer-binding payment flows) are not misled by a non-null lie.
 *
 * Intentionally excludes lines/snapshots/VAT breakdown — those are
 * F4 internals; F5 never renders or mutates them.
 */
export interface InvoiceForPayment {
  readonly id: string;
  readonly status: InvoiceStatus;
  readonly totalSatang: Satang;
  readonly memberId: string | null;
  readonly tenantId: string;
}

export type GetInvoiceForPaymentError =
  | { code: 'not_found' }
  | { code: 'forbidden' }
  | { code: 'not_payable'; status: InvoiceStatus };

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
  // Null `total` = draft with no snapshot. Zero `total.satang` = 100%-
  // discounted invoice or a backfill data-quality edge — Stripe rejects
  // any amount below its minimum (50 satang / 0.50 THB), so both cases
  // are non-payable. Surface as a typed error so the caller (webhook
  // reconciliation / portal payment-init) must explicitly handle it
  // through the Result channel rather than silently sending amount=0
  // to the processor.
  if (!invoice.total || invoice.total.satang <= 0n) {
    return err({ code: 'not_payable', status: invoice.status });
  }

  // 054-event-fee-invoices (Task 8) — the F5 → F4 payment bridge binds a
  // payment to a member for RLS, and F5's `payments.member_id` column is NOT
  // NULL. Membership invoices always carry a member_id
  // (`invoices_subject_fields_ck`). NON-member event-fee invoices have
  // `member_id IS NULL`; they are not yet self-payable online — they need a
  // dedicated F5 buyer-binding path (future task) and are settled by
  // admin-record / payment-link in the meantime. Surface them as a typed
  // `not_payable` here rather than letting a null memberId flow downstream
  // (which would be a `payments.member_id` NOT-NULL crash, not a clean error).
  // This guard ALSO narrows `invoice.memberId` to `string` for the mapping
  // below, so the `ok` DTO carries a real id with no `!` assertion despite the
  // field type being the honest `string | null` (see the DTO doc above).
  if (invoice.memberId === null) {
    return err({ code: 'not_payable', status: invoice.status });
  }

  return ok({
    id: invoice.invoiceId,
    status: invoice.status,
    // F5R3 H-5 (2026-05-16) — brand at Money VO escape point.
    totalSatang: asSatang(invoice.total.satang),
    memberId: invoice.memberId,
    tenantId: input.tenantId,
  });
}
