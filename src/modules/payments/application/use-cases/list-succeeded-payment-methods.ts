/**
 * F5 Phase 5 (T096) — listSucceededPaymentMethods use-case.
 *
 * Read-only projection used by the admin invoice reconciliation surface
 * (`/admin/invoices` paid-online filter). For a page of invoice ids,
 * returns a `Map<invoiceId, PaymentMethod>` covering invoices that
 * have at least one succeeded F5 payment. Invoices with no succeeded
 * payment are ABSENT from the map (caller renders no badge).
 *
 * No mutation, no audit emit, no Stripe call — a thin Application
 * facade over `PaymentsRepo.listSucceededMethodByInvoiceIds` so the
 * F4 admin page (Presentation layer) does not import a Repo port
 * directly (Constitution Principle III).
 */
import { ok, type Result } from '@/lib/result';
import type { PaymentsRepo } from '../ports/payments-repo';
import type { PaymentMethod } from '../../domain/value-objects/payment-method';

export interface ListSucceededPaymentMethodsInput {
  readonly tenantId: string;
  readonly invoiceIds: readonly string[];
}

export type ListSucceededPaymentMethodsOutput = ReadonlyMap<string, PaymentMethod>;
export type ListSucceededPaymentMethodsError = never;

export interface ListSucceededPaymentMethodsDeps {
  readonly paymentsRepo: PaymentsRepo;
}

export async function listSucceededPaymentMethods(
  deps: ListSucceededPaymentMethodsDeps,
  input: ListSucceededPaymentMethodsInput,
): Promise<Result<ListSucceededPaymentMethodsOutput, ListSucceededPaymentMethodsError>> {
  const map = await deps.paymentsRepo.listSucceededMethodByInvoiceIds(
    input.tenantId,
    input.invoiceIds,
  );
  return ok(map);
}
