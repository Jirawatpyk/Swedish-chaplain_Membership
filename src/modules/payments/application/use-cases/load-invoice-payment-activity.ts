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
 */
import { ok, type Result } from '@/lib/result';
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

export type LoadInvoicePaymentActivityError = never;

export interface LoadInvoicePaymentActivityDeps {
  readonly paymentsRepo: PaymentsRepo;
}

export async function loadInvoicePaymentActivity(
  deps: LoadInvoicePaymentActivityDeps,
  input: LoadInvoicePaymentActivityInput,
): Promise<
  Result<LoadInvoicePaymentActivityOutput, LoadInvoicePaymentActivityError>
> {
  const activity = await deps.paymentsRepo.listInvoiceActivity(
    input.tenantId,
    input.invoiceId,
  );
  return ok(activity);
}
