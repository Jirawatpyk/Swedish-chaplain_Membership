/**
 * Route-level test for `/api/cron/sweep-stale-pending-refunds` — the hourly
 * cron that runs the stale-pending-refund sweep and then, in the same run,
 * the pending-payment-on-unpayable-invoice cancel retry (financial-integrity
 * review of that change, M3: the route wiring had no test).
 *
 * Pins what only the route decides:
 *   1. 401 on a bad Bearer — neither sweep runs
 *   2. READ_ONLY_MODE → frozen 200 — neither sweep runs
 *   3. Happy path: refund sweep per tenant, then the unpayable sweep ONCE with
 *      a budget ≤ 20s; `pendingOnUnpayable` in the response (without the
 *      errored-invoice id list); one metric per non-zero outcome
 *   4. Unpayable sweep throws → still 200 with the refund totals, status
 *      'failed', failed metric, log carries errKind and never the message
 *   5. A refund-sweep tenant throws → the unpayable sweep still runs
 *   6. tenant_list_failed → 500, and the unpayable sweep still ran
 *   7. Under 5s left of the route budget → skipped_no_budget, sweep not called
 *   8. Errored invoices are logged one line each, with ids + errKind
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';

const envState = vi.hoisted(() => ({ readOnlyMode: false }));
vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    flags: {
      get readOnlyMode() {
        return envState.readOnlyMode;
      },
    },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

const tenantListMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: tenantListMock }) }),
  },
}));

const refundSweepMock = vi.hoisted(() => vi.fn());
const unpayableSweepMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/payments', () => ({
  sweepStalePendingRefunds: refundSweepMock,
  makeSweepStalePendingRefundsDeps: vi.fn((tenantId: string) => ({ tenantId })),
  sweepPendingPaymentsOnUnpayableInvoices: unpayableSweepMock,
  makeSweepPendingOnUnpayableDeps: vi.fn(() => ({ kind: 'unpayable-deps' })),
}));

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ logger }));

const metrics = vi.hoisted(() => ({
  cronSweepTenantFailed: vi.fn(),
  pendingOnUnpayableSwept: vi.fn(),
  pendingOnUnpayableSweepFailed: vi.fn(),
}));
vi.mock('@/lib/metrics', () => ({ paymentsMetrics: metrics }));

vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => 'req-route' }));

import { GET } from '@/app/api/cron/sweep-stale-pending-refunds/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    nextUrl: { searchParams: new URLSearchParams() },
  } as unknown as NextRequest;
}
const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };

const SWEEP_RESULT = {
  invoicesFound: 3,
  invoicesProcessed: 2,
  invoicesErrored: 1,
  erroredInvoices: [{ tenantId: 't1', invoiceId: 'inv-x', errKind: 'PostgresError' }],
  deferred: 0,
  canceled: 2,
  skipped: 0,
  failed: 1,
};

function refundOk() {
  return {
    ok: true,
    value: { sweptCount: 0, skippedCount: 0, escalatedCount: 0, cutoff: 'c' },
  };
}

describe('GET /api/cron/sweep-stale-pending-refunds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.readOnlyMode = false;
    tenantListMock.mockResolvedValue([{ tenantId: 't1' }, { tenantId: 't2' }]);
    refundSweepMock.mockResolvedValue(refundOk());
    unpayableSweepMock.mockResolvedValue(SWEEP_RESULT);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('401 on a bad Bearer — neither sweep runs', async () => {
    const res = await GET(makeRequest({ authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect(refundSweepMock).not.toHaveBeenCalled();
    expect(unpayableSweepMock).not.toHaveBeenCalled();
  });

  it('READ_ONLY_MODE → frozen 200 — neither sweep runs', async () => {
    envState.readOnlyMode = true;
    const res = await GET(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, reason: 'read_only_mode' });
    expect(refundSweepMock).not.toHaveBeenCalled();
    expect(unpayableSweepMock).not.toHaveBeenCalled();
  });

  it('runs the refund sweep per tenant, then the unpayable sweep once, and reports both', async () => {
    const res = await GET(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect(refundSweepMock).toHaveBeenCalledTimes(2);
    expect(unpayableSweepMock).toHaveBeenCalledTimes(1);
    expect(refundSweepMock.mock.invocationCallOrder[1]!).toBeLessThan(
      unpayableSweepMock.mock.invocationCallOrder[0]!,
    );
    const [deps, input] = unpayableSweepMock.mock.calls[0]!;
    expect(deps).toEqual({ kind: 'unpayable-deps' });
    expect(input.requestId).toBe('req-route');
    expect(input.budgetMs).toBeGreaterThanOrEqual(5_000);
    expect(input.budgetMs).toBeLessThanOrEqual(20_000);

    const body = await res.json();
    expect(body).toMatchObject({ ok: true, tenantsTotal: 2, tenantsOk: 2 });
    const { erroredInvoices: _omitted, ...counts } = SWEEP_RESULT;
    expect(body.pendingOnUnpayable).toEqual({ status: 'ran', ...counts });
    // The id list is for the log, not the response.
    expect(body.pendingOnUnpayable.erroredInvoices).toBeUndefined();

    expect(metrics.pendingOnUnpayableSwept.mock.calls).toEqual([
      ['canceled', 2],
      ['skipped', 0],
      ['failed', 1],
      ['errored', 1],
      ['deferred', 0],
    ]);
    expect(metrics.pendingOnUnpayableSweepFailed).not.toHaveBeenCalled();
  });

  it('logs each errored invoice with ids + errKind', async () => {
    await GET(makeRequest(VALID_AUTH));
    const threw = logger.error.mock.calls.filter(
      (c) => c[1] === 'cron.sweep_pending_on_unpayable.invoice_threw',
    );
    expect(threw).toEqual([
      [
        { requestId: 'req-route', tenantId: 't1', invoiceId: 'inv-x', errKind: 'PostgresError' },
        'cron.sweep_pending_on_unpayable.invoice_threw',
      ],
    ]);
  });

  it('unpayable sweep throws → 200 with refund totals intact; failed status + metric; no error message logged', async () => {
    unpayableSweepMock.mockRejectedValueOnce(
      new TypeError('relation "payments" SELECT secret_column FROM ...'),
    );
    const res = await GET(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, tenantsOk: 2, pendingOnUnpayable: { status: 'failed' } });
    expect(metrics.pendingOnUnpayableSweepFailed).toHaveBeenCalledTimes(1);
    const failedLog = logger.error.mock.calls.find(
      (c) => c[1] === 'cron.sweep_pending_on_unpayable.failed',
    );
    expect(failedLog?.[0]).toEqual({ requestId: 'req-route', errKind: 'TypeError' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret_column');
  });

  it('a refund-sweep tenant throwing does not stop the unpayable sweep', async () => {
    refundSweepMock.mockRejectedValueOnce(new Error('tenant t1 exploded'));
    const res = await GET(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect(metrics.cronSweepTenantFailed).toHaveBeenCalledWith('t1');
    expect(unpayableSweepMock).toHaveBeenCalledTimes(1);
    expect((await res.json()).pendingOnUnpayable.status).toBe('ran');
  });

  it('tenant list fails → 500, but the unpayable sweep (which does not need it) still ran', async () => {
    tenantListMock.mockRejectedValueOnce(new Error('neon down'));
    const res = await GET(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'tenant_list_failed' });
    expect(refundSweepMock).not.toHaveBeenCalled();
    expect(unpayableSweepMock).toHaveBeenCalledTimes(1);
  });

  it('under 5s of the route budget left → skipped_no_budget; the sweep is not called', async () => {
    // Route start at t=0; by the time the unpayable sweep would start, 52s
    // have passed → 3s left of the 55s soft deadline.
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(0).mockReturnValue(52_000);
    const res = await GET(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect(unpayableSweepMock).not.toHaveBeenCalled();
    expect((await res.json()).pendingOnUnpayable).toEqual({ status: 'skipped_no_budget' });
    expect(metrics.pendingOnUnpayableSwept).toHaveBeenCalledWith('skipped_no_budget', 1);
  });

  it('the budget is capped by the time left, not only by 20s', async () => {
    // 40s elapsed → 15s left of the 55s soft deadline → budget 15s.
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(0).mockReturnValue(40_000);
    await GET(makeRequest(VALID_AUTH));
    expect(unpayableSweepMock.mock.calls[0]![1].budgetMs).toBe(15_000);
  });
});
