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
const keptMetric = vi.fn();
const flags = vi.hoisted(() => ({ readOnlyMode: false }));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/env', () => ({
  env: { cron: { secret: 'cron-secret-for-test' }, tenant: { slug: 'test-tenant' }, flags },
}));
vi.mock('@/lib/metrics', () => ({
  broadcastsMetrics: {
    retentionSwept: (...args: unknown[]) => sweptMetric(...args),
    retentionSweepFailed: (...args: unknown[]) => failedMetric(...args),
    retentionProviderCopyKept: (...args: unknown[]) => keptMetric(...args),
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

const SUCCESS = {
  sweptCount: 3,
  imagesMarked: 1,
  batches: 1,
  budgetExhausted: false,
  providerCopyKeptTransient: 0,
  providerCopyKeptRefused: 0,
  oldestAnchor: new Date('2026-01-01T00:00:00.000Z'),
  newestAnchor: new Date('2026-01-03T00:00:00.000Z'),
};

/** A Drizzle query error: its message quotes the statement's params, its cause carries the SQLSTATE. */
class DrizzleQueryError extends Error {}
const MEMBER_ID = '7f3c1a52-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  flags.readOnlyMode = false;
  sweepMock.mockResolvedValue(ok(SUCCESS));
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
          ...SUCCESS,
          oldestAnchor: '2026-01-01T00:00:00.000Z',
          newestAnchor: '2026-01-03T00:00:00.000Z',
        },
      ],
    });
    expect(makeDepsMock).toHaveBeenCalledWith('test-tenant', expect.stringMatching(/^cron-retention-sweep-\d+$/));
    expect(sweptMetric).toHaveBeenCalledWith('test-tenant', 3);
    expect(failedMetric).not.toHaveBeenCalled();
  });

  it('READ_ONLY_MODE: 200 skipped and nothing runs — Vercel Cron calls GET, which the proxy write-freeze does not stop', async () => {
    flags.readOnlyMode = true;
    const { GET } = await importRoute();
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true, reason: 'read_only_mode' });
    expect(sweepMock).not.toHaveBeenCalled();
    expect(makeDepsMock).not.toHaveBeenCalled();
  });

  it('READ_ONLY_MODE still answers 401 to a wrong secret (the bearer gate comes first)', async () => {
    flags.readOnlyMode = true;
    const { GET } = await importRoute();
    const res = await GET(req('GET', 'Bearer not-the-secret'));
    expect(res.status).toBe(401);
  });

  it('meters the rows kept because their Resend copy could not be deleted, per reason', async () => {
    sweepMock.mockResolvedValueOnce(ok({ ...SUCCESS, providerCopyKeptTransient: 2, providerCopyKeptRefused: 5 }));
    const { POST } = await importRoute();
    await POST(req('POST'));
    expect(keptMetric).toHaveBeenCalledWith('test-tenant', 'transient', 2);
    expect(keptMetric).toHaveBeenCalledWith('test-tenant', 'refused', 5);
  });

  it('a tenant whose sweep returns an error logs the error CLASS and SQLSTATE only — no query text, no params, no ids', async () => {
    const cause = new DrizzleQueryError(
      `Failed query: DELETE FROM broadcasts WHERE broadcast_id = ANY($2)\nparams: test-tenant,${MEMBER_ID}`,
      { cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }) },
    );
    sweepMock.mockResolvedValueOnce(err({ kind: 'retention_sweep.server_error', cause, sweptCount: 200 }));
    const { POST } = await importRoute();
    const { logger } = await import('@/lib/logger');
    await POST(req('POST'));

    const [fields, msg] = vi.mocked(logger.error).mock.calls[0]!;
    expect(msg).toBe('cron.broadcasts.retention_sweep.server_error');
    expect(fields).toEqual({
      tenantId: 'test-tenant',
      sweptCount: 200,
      err: 'DrizzleQueryError',
      code: '55P03',
      errorId: 'F7.cron.retention_sweep.server_error',
    });
    const everyLogLine = JSON.stringify([
      vi.mocked(logger.error).mock.calls,
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.warn).mock.calls,
    ]);
    expect(everyLogLine).not.toContain(MEMBER_ID);
    expect(everyLogLine).not.toMatch(/Failed query|params|lock timeout/);
  });

  it('a tenant whose sweep returns an error: 200, outcome error with the rows that did commit, the failure metered', async () => {
    sweepMock.mockResolvedValueOnce(
      err({ kind: 'retention_sweep.server_error', cause: new Error('relation "x" does not exist'), sweptCount: 200 }),
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
