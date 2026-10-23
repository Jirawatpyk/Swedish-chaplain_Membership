/**
 * Spec 124 follow-up — contract for the invoicing → payments boundary the
 * admin CSV export crosses: `makeExportPaidInvoicesCsvDeps` wires its
 * `paymentMethodLookup` port with the payments barrel's
 * `listCollectedPaymentMethods`. This pins what the export relies on:
 *
 *   1. the barrel exports the use case and its deps factory;
 *   2. the use case passes the repo's map through as `ok(map)` (the export
 *      treats `!ok` as "no methods", which would print `manual` everywhere);
 *   3. the "collected" status list is succeeded / partially_refunded /
 *      refunded — the same list the invoice dashboard's method card reads.
 *
 * The SQL itself (statuses, latest-first pick, tenant scope) is exercised
 * against Postgres in
 * `tests/integration/invoicing/export-csv-stripe-refunded-method.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  listCollectedPaymentMethods,
  makeListCollectedPaymentMethodsDeps,
  SUCCEEDED_LINEAGE,
} from '@/modules/payments';
import type { PaymentsRepo } from '@/modules/payments/application/ports/payments-repo';
import { makeExportPaidInvoicesCsvDeps } from '@/modules/invoicing';

describe('CSV export → payments method lookup contract', () => {
  it('the payments barrel exports the lookup and its deps factory', () => {
    expect(typeof listCollectedPaymentMethods).toBe('function');
    expect(typeof makeListCollectedPaymentMethodsDeps).toBe('function');
    expect(typeof makeExportPaidInvoicesCsvDeps('test-tenant').paymentMethodLookup).toBe(
      'function',
    );
  });

  it('returns ok with the repo map unchanged', async () => {
    const map = new Map([['inv-1', 'card' as const]]);
    const paymentsRepo = {
      listCollectedMethodByInvoiceIds: vi.fn().mockResolvedValue(map),
    } as unknown as PaymentsRepo;
    const result = await listCollectedPaymentMethods(
      { paymentsRepo },
      { tenantId: 'test-tenant', invoiceIds: ['inv-1'] },
    );
    expect(result).toEqual({ ok: true, value: map });
  });

  it('a refunded or partially refunded payment still counts as collected', () => {
    expect([...SUCCEEDED_LINEAGE].sort()).toEqual(['partially_refunded', 'refunded', 'succeeded']);
  });
});
