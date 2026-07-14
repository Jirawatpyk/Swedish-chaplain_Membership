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
import type { TaxAtPaymentFlag } from '../../domain/tax-at-payment-flag';
// REMOVE-WITH-064-REMEDIATION — legacy no-TIN event payability guard below.
import { buyerHasTin } from '../../domain/document-kind';

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
  /**
   * 088 SEC-MED — FEATURE_088_TAX_AT_PAYMENT (2-state flow flag), threaded on
   * EVERY read as the honest `env.features.f088TaxAtPayment` value. The
   * new-flow-bill flag-rollback guard below trips only when the flow is `'off'`
   * AND this is NOT a reconciliation read (see `reconciliationPath`).
   */
  readonly taxAtPayment: TaxAtPaymentFlag;
  /**
   * 088 SEC-MED — the ORTHOGONAL reconciliation axis. `true` on the webhook /
   * confirm-payment reconciliation read: the money was already captured by the
   * processor, so the stranded-funds guard MUST stay DORMANT regardless of the
   * flow flag (refusing here would strand funds, not prevent a capture). `false`
   * on the initiate (portal/admin self-pay) read, where the guard fires BEFORE a
   * PaymentIntent is created so a new-flow bill minted under the flag cannot be
   * paid after a flag rollback. Explicit boolean (not a magic flag value) so the
   * dormancy is named, not encoded in the flow union.
   */
  readonly reconciliationPath: boolean;
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
  | { code: 'not_payable'; status: InvoiceStatus }
  /**
   * REMOVE-WITH-064-REMEDIATION (online-payment site — master checklist
   * at the guard in record-payment.ts +
   * docs/runbooks/event-invoice-legacy-no-tin-remediation.md) — the
   * invoice is a LEGACY issued no-TIN EVENT row. Paying it online would
   * capture money that the webhook-side `recordPayment` guard then
   * refuses to apply (`legacy_no_tin_event_needs_remediation` →
   * permanent `bridge_error` ack, NO auto-refund) — an S0 money trap.
   * Distinct from `not_payable` so F5's logs keep the runbook pointer.
   */
  | { code: 'legacy_no_tin_event_not_payable' }
  /**
   * 088 SEC-MED — SYMMETRIC to the record-payment webhook guard. A NEW-FLOW
   * bill (NULL §87 `documentNumber` + non-§87 `billDocumentNumberRaw`, issued
   * while FEATURE_088_TAX_AT_PAYMENT was ON) is being read for payment on the
   * INITIATE side while the flag is now OFF. Creating a PI would let Stripe
   * capture money the webhook-side `recordPayment` guard then refuses to apply
   * (same code, permanent, NO auto-refund) — S0 stranded funds. Reject at the
   * payability read so the PI is never created. Distinct from `not_payable`
   * (mirroring `legacy_no_tin_event_not_payable`) so F5's logs keep the
   * flag-rollback discriminator for ops.
   */
  | { code: 'new_flow_bill_requires_flag_on' };

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

  // REMOVE-WITH-064-REMEDIATION (online-payment site — master checklist at
  // the guard in record-payment.ts). A LEGACY pre-064 issued no-TIN EVENT
  // row's issue-time PDF already IS the buyer's §105 ใบเสร็จรับเงิน. If F5
  // creates a PI against it, Stripe captures the money but the webhook-side
  // `recordPayment` guard rejects the invoice flip with
  // `legacy_no_tin_event_needs_remediation` — classified PERMANENT (200-ack,
  // no Stripe retry, no auto-refund) — stranding the funds (S0). Reject at
  // the payability read so the PI is never created. Matched-member rows are
  // the live trap (null-member rows are already stopped by the guard above);
  // NEW no-TIN event fees can't reach 'issued' (issueInvoice rejects them
  // with `event_no_tin_requires_paid_issue`), so only pre-064 rows hit this.
  // Status-scoped to 'issued' so paid/credited legacy rows keep their
  // existing read/refund behaviour. `buyerHasTin` trims — whitespace-only
  // tax_id counts as no-TIN, mirroring the record-payment guard.
  //
  // 059 / PR-A Task 6a — DELIBERATELY NOT re-keyed onto the registrant flag.
  // Like its record-payment twin this is FORENSICS: it reconstructs what a
  // PRE-064 row's already-issued PDF ACTUALLY RENDERED AS, under the rule in
  // force at the time (`buyerHasTin`). Re-keying it would rewrite history and
  // misclassify legitimate old rows. Leave it.
  if (
    invoice.invoiceSubject === 'event' &&
    invoice.status === 'issued' &&
    !buyerHasTin(invoice.memberIdentitySnapshot?.tax_id)
  ) {
    return err({ code: 'legacy_no_tin_event_not_payable' });
  }

  // 088 SEC-MED — SYMMETRIC to the record-payment webhook guard
  // (`new_flow_bill_requires_flag_on`, record-payment.ts). A NEW-FLOW bill
  // (non-§87 `billDocumentNumberRaw`, NULL §87 `documentNumber`, issued while
  // the flag was ON) must NOT be online-payable after the flag is rolled back
  // to OFF: the initiate side would create a Stripe PI, Stripe would CAPTURE
  // the money, then the webhook-side `recordPayment` guard refuses the flip
  // (same code, permanent, no auto-refund) — captured-but-unappliable funds
  // (S0). Reject at the payability read so the PI is NEVER created. Two axes gate
  // it: (1) `reconciliationPath !== true` — a webhook/confirm-payment read is EXEMPT
  // (the money is already captured; refusing would strand it, and the write-side
  // record-payment guard still enforces the flag); (2) `taxAtPayment === 'off'` —
  // only the explicit prod flag-OFF flow trips it (flag-ON is the intended state
  // for a new-flow bill). Status-scoped to 'issued' so paid/credited rows keep
  // their read/refund behaviour. See the master rationale + runbook at the
  // record-payment guard.
  if (
    input.reconciliationPath !== true &&
    input.taxAtPayment === 'off' &&
    invoice.documentNumber === null &&
    invoice.billDocumentNumberRaw !== null &&
    invoice.status === 'issued'
  ) {
    return err({ code: 'new_flow_bill_requires_flag_on' });
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
