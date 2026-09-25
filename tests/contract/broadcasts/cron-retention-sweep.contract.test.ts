/**
 * F7 retention sweep (migration 0310) — wire contract of
 * `GET|POST /api/cron/broadcasts/retention-sweep`.
 *
 * Native Vercel Cron invokes GET, so `GET = POST`. The `CRON_SECRET` bearer
 * gates everything. The route loops the known tenants; one tenant's failure is
 * reported in the per-tenant list and never drops another tenant, and the
 * response stays 200 (a daily-cron 500 would hide the tenants that DID
 * succeed — the alert rides `broadcasts_retention_sweep_failed_total`).
 *
 * Use case mocked at the barrel; its loop is pinned in
 * `tests/unit/broadcasts/application/sweep-expired-broadcasts.test.ts`, and
 * what it deletes in `tests/integration/broadcasts/broadcast-retention-sweep.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

const sweepMock = vi.fn();
const makeDepsMock = vi.fn((tenant: string, requestId: string) => ({ tenant, requestId }));
const sweptMetric = vi.fn();
const failedMetric = vi.fn();

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/env', () => ({
  env: { cron: { secret: 'cron-secret-for-test' }, tenant: { slug: 'test-tenant' } },
}));
vi.mock('@/lib/metrics', () => ({
  broadcastsMetrics: {
    retentionSwept: (...args: unknown[]) => sweptMetric(...args),
    retentionSweepFailed: (...args: unknown[]) => failedMetric(...args),
  },
}));
vi.mock('@/modules/broadcasts', () => ({
  sweepExpiredBroadcasts: (...args: unknown[]) => sweepMock(...args),
  makeSweepExpiredBroadcastsDeps: (tenant: string, requestId: string) => makeDepsMock(tenant, requestId),
}));

function req(method: 'GET' | 'POST', auth: string | null = 'Bearer cron-secret-for-test'): NextRequest {
  return new NextRequest('http://localhost/api/cron/broadcasts/retention-sweep', {
    method,
    headers: auth === null ? {} : { authorization: auth },
  });
}
const importRoute = () => import('@/app/api/cron/broadcasts/retention-sweep/route');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  sweepMock.mockResolvedValue(ok({ sweptCount: 3, imagesMarked: 1, batches: 1, budgetExhausted: false }));
});
afterEach(() => vi.clearAllMocks());

describe('/api/cron/broadcasts/retention-sweep', () => {
  it('GET and POST are the same handler; a function budget of 300 s', async () => {
    const route = await importRoute();
    expect(route.GET).toBe(route.POST);
    expect(route.maxDuration).toBe(300);
  });

  it.each([
    ['no Authorization header', null],
    ['a wrong secret', 'Bearer not-the-secret'],
  ])('401 with %s — and nothing runs', async (_label, auth) => {
    const { GET } = await importRoute();
    const res = await GET(req('GET', auth));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized' } });
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('runs the sweep once per known tenant and reports each tenant\'s counts', async () => {
    const { GET } = await importRoute();
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      perTenant: [
        {
          tenantId: 'test-tenant',
          outcome: 'success',
          sweptCount: 3,
          imagesMarked: 1,
          batches: 1,
          budgetExhausted: false,
        },
      ],
    });
    expect(makeDepsMock).toHaveBeenCalledWith('test-tenant', expect.stringMatching(/^cron-retention-sweep-\d+$/));
    expect(sweptMetric).toHaveBeenCalledWith('test-tenant', 3);
    expect(failedMetric).not.toHaveBeenCalled();
  });

  it('a tenant whose sweep returns an error: 200, outcome error with the rows that did commit, the failure metered', async () => {
    sweepMock.mockResolvedValueOnce(
      err({ kind: 'retention_sweep.server_error', message: 'relation "x" does not exist', sweptCount: 200 }),
    );
    const { POST } = await importRoute();
    const { logger } = await import('@/lib/logger');
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      perTenant: [{ tenantId: 'test-tenant', outcome: 'error', sweptCount: 200 }],
    });
    // The raw DB message stays in the server log, never in the response body.
    expect(JSON.stringify(body)).not.toContain('does not exist');
    expect(sweptMetric).toHaveBeenCalledWith('test-tenant', 200);
    expect(failedMetric).toHaveBeenCalledWith('test-tenant');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'test-tenant', errorId: 'F7.cron.retention_sweep.server_error' }),
      'cron.broadcasts.retention_sweep.server_error',
    );
  });

  it('a tenant whose sweep throws: 200, outcome error, logged by error kind only', async () => {
    sweepMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:5432'));
    const { POST } = await importRoute();
    const { logger } = await import('@/lib/logger');
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, perTenant: [{ tenantId: 'test-tenant', outcome: 'error' }] });
    expect(failedMetric).toHaveBeenCalledWith('test-tenant');
    expect(sweptMetric).not.toHaveBeenCalled();
    const [fields, msg] = vi.mocked(logger.error).mock.calls[0]!;
    expect(msg).toBe('cron.broadcasts.retention_sweep.uncaught_error');
    expect(fields).toMatchObject({ tenantId: 'test-tenant', errorId: 'F7.cron.retention_sweep.uncaught' });
    expect(JSON.stringify(fields)).not.toContain('10.0.0.1');
  });
});
