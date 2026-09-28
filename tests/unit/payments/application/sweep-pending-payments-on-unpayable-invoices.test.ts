/**
 * sweepPendingPaymentsOnUnpayableInvoices — the hourly retry for a void-time
 * cancel that failed or never ran (follow-up to the #447 review).
 *
 * `voidInvoice` cancels the voided invoice's pending PaymentIntents best-effort
 * after it commits. When that fails (Stripe retryable, DB fault, missing
 * settings) the row stayed `pending` forever and nothing retried it. This sweep
 * finds pending attempts on invoices that are no longer `issued` and re-runs
 * `cancelPendingPaymentsForInvoice` per invoice — idempotent and overlap-safe
 * because that use-case takes initiate's advisory lock + per-row locks + CAS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sweepPendingPaymentsOnUnpayableInvoices,
  PENDING_ON_UNPAYABLE_MIN_AGE_MINUTES,
  PENDING_ON_UNPAYABLE_MAX_AGE_DAYS,
  PENDING_ON_UNPAYABLE_BATCH_LIMIT,
  type SweepPendingOnUnpayableDeps,
} from '@/modules/payments';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '@/modules/payments';

const cancelMock = vi.hoisted(() => vi.fn());
vi.mock(
  '@/modules/payments/application/use-cases/cancel-pending-payments-for-invoice',
  async (importOriginal) => {
    const actual = await importOriginal<object>();
    return { ...actual, cancelPendingPaymentsForInvoice: cancelMock };
  },
);

function makeDeps(
  pairs: Array<{ tenantId: string; invoiceId: string }>,
  nowSteps: number[] = [0],
) {
  let i = 0;
  const finder = {
    listInvoicesWithPendingOnUnpayable: vi.fn(async () => pairs),
  };
  const cancelDepsFor = vi.fn((tenantId: string) => ({ tenant: tenantId }) as never);
  const deps: SweepPendingOnUnpayableDeps = {
    finder,
    cancelDepsFor,
    clock: {
      nowIso: () => '2026-09-28T00:00:00.000Z',
      nowMs: () => nowSteps[Math.min(i++, nowSteps.length - 1)]!,
    },
  };
  return { deps, finder, cancelDepsFor };
}

describe('sweepPendingPaymentsOnUnpayableInvoices', () => {
  beforeEach(() => {
    cancelMock.mockReset();
    cancelMock.mockResolvedValue({ canceled: 1, skipped: 0, failed: 0 });
  });

  it('queries with the 15-minute floor, 7-day cap and batch limit', async () => {
    const h = makeDeps([]);
    const r = await sweepPendingPaymentsOnUnpayableInvoices(h.deps, {
      requestId: 'req-1',
      budgetMs: 10_000,
    });
    expect(PENDING_ON_UNPAYABLE_MIN_AGE_MINUTES).toBe(15);
    expect(PENDING_ON_UNPAYABLE_MAX_AGE_DAYS).toBe(7);
    expect(PENDING_ON_UNPAYABLE_BATCH_LIMIT).toBe(50);
    expect(h.finder.listInvoicesWithPendingOnUnpayable).toHaveBeenCalledWith({
      minAgeMinutes: 15,
      maxAgeDays: 7,
      limit: 50,
    });
    expect(r).toEqual({
      invoicesFound: 0,
      invoicesProcessed: 0,
      invoicesErrored: 0,
      erroredInvoices: [],
      deferred: 0,
      canceled: 0,
      skipped: 0,
      failed: 0,
    });
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('cancels per invoice with that tenant\'s deps, the system actor and the sweep cause; sums outcomes', async () => {
    const h = makeDeps([
      { tenantId: 't1', invoiceId: 'inv-a' },
      { tenantId: 't2', invoiceId: 'inv-b' },
    ]);
    cancelMock
      .mockResolvedValueOnce({ canceled: 1, skipped: 0, failed: 0 })
      .mockResolvedValueOnce({ canceled: 0, skipped: 1, failed: 1 });
    const r = await sweepPendingPaymentsOnUnpayableInvoices(h.deps, {
      requestId: 'req-2',
      budgetMs: 10_000,
    });
    expect(h.cancelDepsFor.mock.calls).toEqual([['t1'], ['t2']]);
    expect(cancelMock).toHaveBeenNthCalledWith(1, { tenant: 't1' }, {
      tenantId: 't1',
      invoiceId: 'inv-a',
      actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
      cause: 'invoice_not_payable_sweep',
      requestId: 'req-2',
    });
    expect(r).toMatchObject({
      invoicesFound: 2,
      invoicesProcessed: 2,
      canceled: 1,
      skipped: 1,
      failed: 1,
      invoicesErrored: 0,
      deferred: 0,
    });
  });

  it('one invoice throwing (DB fault) is isolated — counted errored, the rest still run', async () => {
    const h = makeDeps([
      { tenantId: 't1', invoiceId: 'inv-a' },
      { tenantId: 't1', invoiceId: 'inv-b' },
    ]);
    cancelMock.mockRejectedValueOnce(new Error('neon: connection reset'));
    const r = await sweepPendingPaymentsOnUnpayableInvoices(h.deps, {
      requestId: null,
      budgetMs: 10_000,
    });
    expect(cancelMock).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ invoicesProcessed: 1, invoicesErrored: 1, canceled: 1, deferred: 0 });
    // Named for the route's log line — constructor name only, never `.message`.
    expect(r.erroredInvoices).toEqual([{ tenantId: 't1', invoiceId: 'inv-a', errKind: 'Error' }]);
    expect(JSON.stringify(r)).not.toContain('connection reset');
  });

  it('stops starting invoices once the time budget is spent; the rest are deferred to the next run', async () => {
    // start=0, then before inv-a: 0 (ok), before inv-b: 6000 (> 5000 budget).
    const h = makeDeps(
      [
        { tenantId: 't1', invoiceId: 'inv-a' },
        { tenantId: 't1', invoiceId: 'inv-b' },
        { tenantId: 't1', invoiceId: 'inv-c' },
      ],
      [0, 0, 6_000],
    );
    const r = await sweepPendingPaymentsOnUnpayableInvoices(h.deps, {
      requestId: null,
      budgetMs: 5_000,
    });
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ invoicesFound: 3, invoicesProcessed: 1, deferred: 2 });
  });

  it('a finder failure propagates (the route logs it and keeps the refund sweep result)', async () => {
    const h = makeDeps([]);
    h.finder.listInvoicesWithPendingOnUnpayable.mockRejectedValueOnce(new Error('boom'));
    await expect(
      sweepPendingPaymentsOnUnpayableInvoices(h.deps, { requestId: null, budgetMs: 1_000 }),
    ).rejects.toThrow('boom');
  });
});
