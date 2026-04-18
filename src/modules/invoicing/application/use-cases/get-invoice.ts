/**
 * get-invoice use case (F4) — loads an invoice by id for the current
 * tenant. Used by admin detail + member-portal detail routes. Ownership
 * check for members lives in a separate use case
 * (`get-invoice-pdf-signed-url`) because PDF download emits a probe
 * audit on mismatch; a plain detail-read does not.
 */
import { ok, err, type Result } from '@/lib/result';
import type { InvoiceRepo } from '../ports/invoice-repo';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';

export interface GetInvoiceInput {
  readonly tenantId: string;
  readonly invoiceId: string;
}

export type GetInvoiceError = { code: 'not_found' };

export interface GetInvoiceDeps {
  readonly invoiceRepo: InvoiceRepo;
}

export async function getInvoice(
  deps: GetInvoiceDeps,
  input: GetInvoiceInput,
): Promise<Result<Invoice, GetInvoiceError>> {
  const invoice = await deps.invoiceRepo.findById(asInvoiceId(input.invoiceId), input.tenantId);
  if (!invoice) return err({ code: 'not_found' });
  return ok(invoice);
}
