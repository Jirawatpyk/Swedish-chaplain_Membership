/**
 * CF-2 — `resolveFailedAutoRefund` use-case (F5 go-live register CF-2).
 *
 * Admin-only "mark failed auto-refund as reconciled" action. When a stale-
 * invoice auto-refund permanently FAILS at Stripe, `processRefundUpdated` emits
 * the 10y forensic `auto_refund_failed_needs_manual_reconcile`. The admin then
 * reconciles out-of-band (manual credit note / Stripe Dashboard refund, per
 * `docs/runbooks/out-of-band-refund.md`) — but pre-CF-2 there was NO "resolved"
 * event, so the admin `AutoRefundFailedAlert` + the member "being reconciled"
 * banner persisted forever (they key off `findStaleInvoiceAutoRefund.failed`, a
 * bare EXISTS over the failure forensic).
 *
 * This use-case emits the append-only `auto_refund_reconciled` counterpart.
 * Because `findStaleInvoiceAutoRefund.failed` is now failure-AND-not-reconciled
 * (see the repo), the emit clears the admin alert + reverts the member banner.
 *
 * Contract:
 *   - REFUSES (`no_failed_auto_refund`) when NO failure forensic exists for the
 *     invoice — there is nothing to reconcile.
 *   - IDEMPOTENT: if a reconcile event already exists → benign `already_reconciled`
 *     no-op (NO second emit; append-only log deduped on read).
 *   - Emits with the acting admin as `actorUserId` + optional free-text `note`.
 *
 * PCI SAQ-A (Principle IV): the payload carries id-refs + optional note only —
 * no card data, no raw Stripe text, no `error.message`.
 *
 * Tenant isolation (Principle I): the read + emit run inside ONE
 * `paymentsRepo.withTx` tenant-scoped tx (never the pool-global `db`); the audit
 * row commits atomically with the read snapshot under the caller's RLS context.
 *
 * Pure Application — no framework / ORM imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { AuditPort } from '../ports/audit-port';
import { retentionFor } from '../ports/audit-port';
import type { PaymentsRepo } from '../ports/payments-repo';

export interface ResolveFailedAutoRefundInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  /** The acting admin's user id — the audit `actorUserId`. */
  readonly actorUserId: string;
  readonly requestId: string | null;
  /** Optional single-line admin memo (bounded + newline-stripped at the route). */
  readonly note?: string;
}

export type ResolveFailedAutoRefundOutcome =
  | {
      readonly kind: 'reconciled';
      readonly paymentId: string;
      readonly processorRefundId: string;
    }
  | { readonly kind: 'already_reconciled' };

export type ResolveFailedAutoRefundError =
  | { readonly code: 'no_failed_auto_refund' }
  | { readonly code: 'internal_error'; readonly cause: unknown };

export interface ResolveFailedAutoRefundDeps {
  readonly paymentsRepo: Pick<
    PaymentsRepo,
    'withTx' | 'findFailedAutoRefundForInvoice'
  >;
  readonly audit: AuditPort;
}

export async function resolveFailedAutoRefund(
  deps: ResolveFailedAutoRefundDeps,
  input: ResolveFailedAutoRefundInput,
): Promise<
  Result<ResolveFailedAutoRefundOutcome, ResolveFailedAutoRefundError>
> {
  try {
    return await deps.paymentsRepo.withTx(
      async (
        tx,
      ): Promise<
        Result<ResolveFailedAutoRefundOutcome, ResolveFailedAutoRefundError>
      > => {
        const failure =
          await deps.paymentsRepo.findFailedAutoRefundForInvoice(
            tx,
            input.tenantId,
            input.invoiceId,
          );

        // No failure forensic → nothing to reconcile. Refuse.
        if (failure === null) {
          return err({ code: 'no_failed_auto_refund' });
        }

        // Idempotent no-op — a reconcile already exists (concurrent admin /
        // double-submit). Do NOT emit a second row.
        if (failure.alreadyReconciled) {
          return ok({ kind: 'already_reconciled' });
        }

        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId,
          eventType: 'auto_refund_reconciled',
          actorUserId: input.actorUserId,
          summary: `Failed auto-refund for invoice ${input.invoiceId} (payment ${failure.paymentId}, refund ${failure.processorRefundId}) marked manually reconciled`,
          payload: {
            invoice_id: input.invoiceId,
            payment_id: failure.paymentId,
            processor_refund_id: failure.processorRefundId,
            ...(input.note !== undefined ? { note: input.note } : {}),
          },
          retentionYears: retentionFor('auto_refund_reconciled'),
        });

        return ok({
          kind: 'reconciled',
          paymentId: failure.paymentId,
          processorRefundId: failure.processorRefundId,
        });
      },
    );
  } catch (e) {
    // Never leak Postgres/Stripe error text — the route maps this to a 500
    // with a correlation id only (PCI + log-hygiene).
    return err({ code: 'internal_error', cause: e });
  }
}
