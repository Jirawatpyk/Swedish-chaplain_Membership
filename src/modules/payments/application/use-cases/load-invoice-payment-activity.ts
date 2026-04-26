/**
 * F5 Phase 5 (T097) — loadInvoicePaymentActivity use-case.
 *
 * Read-only projection consumed by the admin invoice detail timeline
 * panel (`payment-timeline.tsx` server component). Returns every
 * payment + refund row tied to the invoice so the UI can synthesize
 * the chronological event stream:
 *
 *   payment_initiated → payment_succeeded|failed|canceled
 *   → invoice_paid (when terminal=succeeded; emitted by F4 markPaid)
 *   → refund_initiated → refund_succeeded|failed (per refund)
 *
 * No mutation, no audit emit, no Stripe call. Tenant isolation is
 * enforced by `runInTenant` + RLS+FORCE policies inside the repo.
 *
 * Verify-fix C2 (2026-04-26): the previous `error: never` typing
 * silently let DB / RLS errors propagate as thrown exceptions, which
 * surfaced as 500s without context in the admin detail page. This
 * use-case now wraps the repo call in try/catch and returns a typed
 * `Result.err({kind: 'repo_unavailable', cause})` so the server
 * component can render a graceful empty / error state instead of
 * crashing the whole route.
 */
import { ok, err, type Result } from '@/lib/result';
import type {
  PaymentsRepo,
  RefundActivityDto,
} from '../ports/payments-repo';
import type { Payment } from '../../domain/payment';

export interface LoadInvoicePaymentActivityInput {
  readonly tenantId: string;
  readonly invoiceId: string;
}

export interface LoadInvoicePaymentActivityOutput {
  readonly payments: readonly Payment[];
  readonly refunds: readonly RefundActivityDto[];
}

export type LoadInvoicePaymentActivityError = {
  readonly kind: 'repo_unavailable';
  readonly cause: unknown;
};

export interface LoadInvoicePaymentActivityDeps {
  readonly paymentsRepo: PaymentsRepo;
}

export async function loadInvoicePaymentActivity(
  deps: LoadInvoicePaymentActivityDeps,
  input: LoadInvoicePaymentActivityInput,
): Promise<
  Result<LoadInvoicePaymentActivityOutput, LoadInvoicePaymentActivityError>
> {
  try {
    const activity = await deps.paymentsRepo.listInvoiceActivity(
      input.tenantId,
      input.invoiceId,
    );
    return ok(activity);
  } catch (cause) {
    return err({ kind: 'repo_unavailable', cause });
  }
}
