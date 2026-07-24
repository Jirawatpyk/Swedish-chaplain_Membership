/**
 * 8A — the payments-side pending-refund count facade (behind the invoicing
 * PendingRefundGuardPort). Pins the contract the invoicing guard depends on.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  countPendingRefundsForInvoice,
  type CountPendingRefundsForInvoiceDeps,
} from '@/modules/payments/application/use-cases/count-pending-refunds-for-invoice';

describe('countPendingRefundsForInvoice (8A)', () => {
  it('returns ok(count) from the repo, tenant + invoice scoped', async () => {
    const deps: CountPendingRefundsForInvoiceDeps = {
      refundsRepo: { countPendingByInvoice: vi.fn(async () => 3) },
    };

    const r = await countPendingRefundsForInvoice(deps, {
      tenantId: 't1',
      invoiceId: 'inv1',
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(3);
    expect(deps.refundsRepo.countPendingByInvoice).toHaveBeenCalledWith('t1', 'inv1');
  });

  it('folds a repo throw to err(count_failed) — the seam defaults it to 0 (fail-open)', async () => {
    const deps: CountPendingRefundsForInvoiceDeps = {
      refundsRepo: {
        countPendingByInvoice: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    };

    const r = await countPendingRefundsForInvoice(deps, {
      tenantId: 't1',
      invoiceId: 'inv1',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('count_failed');
  });
});
