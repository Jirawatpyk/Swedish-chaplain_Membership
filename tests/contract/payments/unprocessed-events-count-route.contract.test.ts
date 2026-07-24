/**
 * Money-remediation Task 1 — Contract test:
 * GET /api/internal/metrics/unprocessed-events-count
 *
 * Owns ONLY the route's auth gate + HTTP/JSON mapping. The predicate
 * semantics (which rows count as unreconciled) are pinned against live Neon
 * in `tests/integration/payments/unprocessed-events-count.test.ts`.
 *
 * `@/lib/db` is mocked so the 401 assertions can prove the Bearer gate runs
 * BEFORE any database work — a gauge endpoint that queries first and
 * authorises second would leak table shape through timing and burn a
 * connection on every unauthenticated probe.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

const transactionMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({
  db: { transaction: (...args: unknown[]) => transactionMock(...args) },
}));

const gaugeMock = vi.hoisted(() => vi.fn());
// `cron-auth` touches `renewalsMetrics` at module scope — stub both façades
// so module-init survives the partial-env mock.
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: { cronBearerAuthRejected: vi.fn(), redisFallback: vi.fn() },
  paymentsMetrics: { unprocessedEventsCount: (...a: unknown[]) => gaugeMock(...a) },
}));

import { GET } from '@/app/api/internal/metrics/unprocessed-events-count/route';

function makeRequest(authorization: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

describe('GET /api/internal/metrics/unprocessed-events-count — contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401 on a MISSING Authorization header, without touching the database', async () => {
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(401);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(gaugeMock).not.toHaveBeenCalled();
  });

  it('401 on a WRONG Bearer token, without touching the database', async () => {
    const res = await GET(makeRequest('Bearer wrong-secret-deadbeef-0000'));
    expect(res.status).toBe(401);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(gaugeMock).not.toHaveBeenCalled();
  });

  it('200 + one gauge emit per tenant row, labelling a NULL tenant as "unresolved"', async () => {
    // A NULL `tenant_id` is reachable: the ingest route inserts rejection /
    // unknown-account rows before tenant resolution. Dropping those groups
    // would silently under-report; `String(null)` would label them "null".
    transactionMock.mockResolvedValue([
      { tenant_id: 'swecham', count: 3 },
      { tenant_id: null, count: 2 },
    ]);

    const res = await GET(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      tenantCount: number;
      totalUnprocessed: number;
      ageMinutes: number;
      tenants: Array<{ tenantId: string; count: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.tenantCount).toBe(2);
    expect(body.totalUnprocessed).toBe(5);
    expect(body.ageMinutes).toBe(15);
    expect(body.tenants).toEqual([
      { tenantId: 'swecham', count: 3 },
      { tenantId: 'unresolved', count: 2 },
    ]);

    expect(gaugeMock.mock.calls).toEqual([
      ['swecham', 3],
      ['unresolved', 2],
    ]);
  });

  it('500 query_failed when the aggregate throws, with no gauge emitted', async () => {
    transactionMock.mockRejectedValue(new Error('neon down'));
    const res = await GET(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('query_failed');
    expect(gaugeMock).not.toHaveBeenCalled();
  });
});
