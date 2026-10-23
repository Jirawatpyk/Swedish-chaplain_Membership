/**
 * Spec 124 follow-up — `listCollectedPaymentMethods`, the CSV export's
 * method lookup: one method per invoice from its latest payment in
 * `succeeded | partially_refunded | refunded`, so a refunded Stripe payment
 * still names card / PromptPay. A thin facade over
 * `PaymentsRepo.listCollectedMethodByInvoiceIds`; the SQL (statuses,
 * ordering, tenant scope) is proven on live Neon in
 * `tests/integration/invoicing/export-csv-stripe-refunded-method.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { listCollectedPaymentMethods } from '@/modules/payments/application/use-cases/list-collected-payment-methods';
import type { PaymentsRepo } from '@/modules/payments/application/ports/payments-repo';
import type { PaymentMethod } from '@/modules/payments/domain/value-objects/payment-method';

describe('listCollectedPaymentMethods', () => {
  it('returns the repo map for the tenant and ids, unchanged', async () => {
    const repoMap = new Map<string, PaymentMethod>([['inv-1', 'card']]);
    const listCollectedMethodByInvoiceIds = vi.fn().mockResolvedValue(repoMap);
    const paymentsRepo = { listCollectedMethodByInvoiceIds } as unknown as PaymentsRepo;

    const result = await listCollectedPaymentMethods(
      { paymentsRepo },
      { tenantId: 'swecham', invoiceIds: ['inv-1', 'inv-2'] },
    );

    expect(result).toEqual({ ok: true, value: repoMap });
    expect(listCollectedMethodByInvoiceIds).toHaveBeenCalledWith('swecham', ['inv-1', 'inv-2']);
  });
});
