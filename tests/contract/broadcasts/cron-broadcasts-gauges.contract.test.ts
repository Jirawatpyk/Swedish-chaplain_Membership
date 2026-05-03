/**
 * Round 3 review G5 — Contract test: GET /api/internal/metrics/broadcasts-gauges.
 *
 * Wire-contract surfaces:
 *   - missing Authorization header                  → 401 unauthorized
 *   - wrong Bearer token                            → 401 unauthorized
 *   - production env without CRON_SECRET            → 401 unauthorized
 *   - valid bearer + DB query OK                    → 200 + summary shape
 *     (queuePending + stuckSending + dispatchRatio counters all emit
 *      via broadcastsMetrics)
 *   - valid bearer + DB transaction throws          → 500 query_failed
 *
 * Per-tenant gauge emission for `dispatch_failure_rate` is the
 * Round 3 G1+G5 observability fix surface — this test pins the
 * route's emit + summary contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbTransactionMock = vi.fn();
const queuePendingSpy = vi.fn();
const stuckSendingCountSpy = vi.fn();
const dispatchFailureRateSpy = vi.fn();

const envMock = {
  isDevelopment: false,
};

vi.mock('@/lib/env', () => ({
  env: envMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {
    transaction: (...args: unknown[]) => dbTransactionMock(...args),
  },
}));
vi.mock('@/lib/cron-auth', () => ({
  verifyCronBearer: (header: string | null, expected: string) => {
    if (header === null) return false;
    if (!header.startsWith('Bearer ')) return false;
    return header.slice('Bearer '.length) === expected;
  },
}));
vi.mock('@/lib/metrics', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/metrics')>('@/lib/metrics');
  return {
    ...actual,
    broadcastsMetrics: {
      ...actual.broadcastsMetrics,
      queuePending: queuePendingSpy,
      stuckSendingCount: stuckSendingCountSpy,
      dispatchFailureRate: dispatchFailureRateSpy,
    },
  };
});

function makeRequest(auth?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (auth !== undefined) headers['authorization'] = auth;
  return new NextRequest(
    'http://localhost/api/internal/metrics/broadcasts-gauges',
    { method: 'GET', headers },
  );
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  envMock.isDevelopment = false;
  dbTransactionMock.mockReset();
  queuePendingSpy.mockReset();
  stuckSendingCountSpy.mockReset();
  dispatchFailureRateSpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CRON_SECRET;
});

describe('GET /api/internal/metrics/broadcasts-gauges — wire contract', () => {
  it('missing Authorization → 401 unauthorized', async () => {
    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(dbTransactionMock).not.toHaveBeenCalled();
    expect(queuePendingSpy).not.toHaveBeenCalled();
  });

  it('wrong Bearer token → 401 unauthorized', async () => {
    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer wrong-secret'));
    expect(res.status).toBe(401);
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });

  it('production env without CRON_SECRET configured → 401 unauthorized', async () => {
    delete process.env.CRON_SECRET;
    envMock.isDevelopment = false;
    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer anything'));
    expect(res.status).toBe(401);
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });

  it('valid bearer + 3 tenants with traffic → 200 + emits all 3 gauge families', async () => {
    dbTransactionMock.mockImplementationOnce(async () => ({
      pendingRows: [{ tenant_id: 't1', count: 12 }],
      stuckRows: [{ tenant_id: 't1', count: 2 }],
      // tenant t1: 30% failure rate (3/10), tenant t2: 0% (0/5)
      dispatchRows: [
        { tenant_id: 't1', failed: 3, dispatched: 10 },
        { tenant_id: 't2', failed: 0, dispatched: 5 },
      ],
    }));

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      pendingTenantCount: number;
      stuckTenantCount: number;
      dispatchRatioTenantCount: number;
      pendingTotal: number;
      stuckTotal: number;
      dispatchRatioMaxBps: number;
      stuckHours: number;
      dispatchWindowHours: number;
    };

    expect(body.ok).toBe(true);
    expect(body.pendingTenantCount).toBe(1);
    expect(body.stuckTenantCount).toBe(1);
    expect(body.dispatchRatioTenantCount).toBe(2);
    expect(body.pendingTotal).toBe(12);
    expect(body.stuckTotal).toBe(2);
    // 30% = 3000 bps; t2 = 0 bps → max is 3000.
    expect(body.dispatchRatioMaxBps).toBe(3000);
    expect(body.stuckHours).toBe(24);
    expect(body.dispatchWindowHours).toBe(1);

    expect(queuePendingSpy).toHaveBeenCalledWith('t1', 12);
    expect(stuckSendingCountSpy).toHaveBeenCalledWith('t1', 2);
    expect(dispatchFailureRateSpy).toHaveBeenCalledWith('t1', 0.3);
    expect(dispatchFailureRateSpy).toHaveBeenCalledWith('t2', 0);
  });

  it('valid bearer + zero traffic → 200 + zero summary, no metrics emitted', async () => {
    dbTransactionMock.mockImplementationOnce(async () => ({
      pendingRows: [],
      stuckRows: [],
      dispatchRows: [],
    }));

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dispatchRatioMaxBps: number };
    expect(body.dispatchRatioMaxBps).toBe(0);
    expect(queuePendingSpy).not.toHaveBeenCalled();
    expect(stuckSendingCountSpy).not.toHaveBeenCalled();
    expect(dispatchFailureRateSpy).not.toHaveBeenCalled();
  });

  it('valid bearer + DB transaction throws → 500 query_failed (no metrics emitted)', async () => {
    dbTransactionMock.mockImplementationOnce(async () => {
      throw new Error('Neon: connection terminated');
    });

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('query_failed');
    expect(queuePendingSpy).not.toHaveBeenCalled();
    expect(dispatchFailureRateSpy).not.toHaveBeenCalled();
  });

  it('dev env without CRON_SECRET → request still allowed (smoke convenience)', async () => {
    delete process.env.CRON_SECRET;
    envMock.isDevelopment = true;
    dbTransactionMock.mockImplementationOnce(async () => ({
      pendingRows: [],
      stuckRows: [],
      dispatchRows: [],
    }));

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });
});
