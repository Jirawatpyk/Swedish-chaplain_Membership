/**
 * Spec 124 follow-up — listCollectedPaymentMethods use-case.
 *
 * The method that collected each invoice, for the admin invoice CSV export:
 * a `Map<invoiceId, PaymentMethod>` from each invoice's latest payment in
 * `succeeded | partially_refunded | refunded`, so a card or PromptPay payment
 * that was later refunded still names its channel (succeeded-only dropped it
 * and the row printed `manual`). Invoices with no such payment are ABSENT.
 *
 * Kept apart from `listSucceededPaymentMethods`, whose caller (the list's
 * paid-online filter) wants succeeded-only. A thin Application facade over
 * `PaymentsRepo.listCollectedMethodByInvoiceIds` (Constitution Principle III).
 */
import { ok, type Result } from '@/lib/result';
import type { PaymentsRepo } from '../ports/payments-repo';
import type { PaymentMethod } from '../../domain/value-objects/payment-method';

export interface ListCollectedPaymentMethodsInput {
  readonly tenantId: string;
  readonly invoiceIds: readonly string[];
}

export type ListCollectedPaymentMethodsOutput = ReadonlyMap<string, PaymentMethod>;
export type ListCollectedPaymentMethodsError = never;

export interface ListCollectedPaymentMethodsDeps {
  readonly paymentsRepo: PaymentsRepo;
}

export async function listCollectedPaymentMethods(
  deps: ListCollectedPaymentMethodsDeps,
  input: ListCollectedPaymentMethodsInput,
): Promise<Result<ListCollectedPaymentMethodsOutput, ListCollectedPaymentMethodsError>> {
  return ok(await deps.paymentsRepo.listCollectedMethodByInvoiceIds(input.tenantId, input.invoiceIds));
}
