/**
 * Finding #20 defense-in-depth — Contract test:
 * GET /api/internal/cron/plan-change-divergence
 *
 * Owns ONLY the route's auth gate + HTTP/JSON mapping + the per-tenant counter
 * emit. The scan predicate semantics (which cycle↔§86/4 pairs count as diverged)
 * are pinned against live Neon in
 * `tests/integration/scripts/check-plan-change-divergence.test.ts`.
 *
 * The scan is mocked so the 401 assertions prove the Bearer gate runs BEFORE any
 * database work — an endpoint that scans first and authorises second would burn a
 * connection + a full-table scan on every unauthenticated probe.
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

const detectedMock = vi.hoisted(() => vi.fn());
// `cron-auth` touches `renewalsMetrics` at module scope — stub the façade so
// module-init survives the partial-env mock, and expose the counter under test.
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    cronBearerAuthRejected: vi.fn(),
    redisFallback: vi.fn(),
    planChangeDivergenceDetected: (...a: unknown[]) => detectedMock(...a),
  },
}));

const scanMock = vi.hoisted(() => vi.fn());
vi.mock('@/../scripts/check-plan-change-divergence', () => ({
  checkPlanChangeDivergence: (...args: unknown[]) => scanMock(...args),
}));

import { GET } from '@/app/api/internal/cron/plan-change-divergence/route';

function makeRequest(authorization: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

describe('GET /api/internal/cron/plan-change-divergence — contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401 on a MISSING Authorization header, without running the scan', async () => {
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(401);
    expect(scanMock).not.toHaveBeenCalled();
    expect(detectedMock).not.toHaveBeenCalled();
  });

  it('401 on a WRONG Bearer token, without running the scan', async () => {
    const res = await GET(makeRequest('Bearer wrong-secret-deadbeef-0000'));
    expect(res.status).toBe(401);
    expect(scanMock).not.toHaveBeenCalled();
    expect(detectedMock).not.toHaveBeenCalled();
  });

  it('200 clean when the scan finds no divergences — no counter emitted', async () => {
    scanMock.mockResolvedValue({ scannedCount: 7, divergences: [] });
    const res = await GET(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      scannedCount: number;
      divergenceCount: number;
    };
    expect(body).toEqual({ ok: true, scannedCount: 7, divergenceCount: 0 });
    expect(detectedMock).not.toHaveBeenCalled();
  });

  it('500 + per-tenant counter when divergences are found', async () => {
    scanMock.mockResolvedValue({
      scannedCount: 5,
      divergences: [
        { tenantId: 'swecham', cycleId: 'c1' },
        { tenantId: 'swecham', cycleId: 'c2' },
        { tenantId: 'acme', cycleId: 'c3' },
      ],
    });
    const res = await GET(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      ok: boolean;
      divergenceCount: number;
    };
    expect(body.ok).toBe(false);
    expect(body.divergenceCount).toBe(3);
    // One emit per tenant, carrying that tenant's divergence count.
    expect(detectedMock.mock.calls).toEqual([
      ['swecham', 2],
      ['acme', 1],
    ]);
  });

  it('500 scan_failed when the scan throws, with no counter emitted', async () => {
    scanMock.mockRejectedValue(new Error('neon down'));
    const res = await GET(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('scan_failed');
    expect(detectedMock).not.toHaveBeenCalled();
  });
});
