/**
 * 088 US8 UX-B2 (T061f) — Contract test:
 * POST /api/cron/invoicing/prune-orphaned-zero-rate-certs
 *
 * Mirrors the F6 sweep-error-csv-blobs route contract test: verifies the
 * Bearer gate + the discriminated-outcome → HTTP mapping, with the composition
 * wrapper (`runPruneOrphanedZeroRateCerts`) mocked so no real Neon / Vercel
 * Blob is touched (the sweep's orphan-rule branches are pinned by the unit
 * suite; this file owns ONLY the route's auth + HTTP-mapping contract):
 *   - missing / wrong Bearer         → 401 unauthorized (no work)
 *   - wrapper `kind:'scan_failed'`   → 500 scan_failed
 *   - wrapper `kind:'ok'`            → 200 + { ok, scanned, swept, skipped, cutoff }
 *   - wrapper throws unexpectedly    → 500 scan_failed
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
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

// cron-auth references `renewalsMetrics` at module scope — no-op stub so
// module-init does not crash under the partial-env mock.
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: { cronBearerAuthRejected: vi.fn(), redisFallback: vi.fn() },
}));

const runPruneMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/invoicing-cert-prune-deps', () => ({
  runPruneOrphanedZeroRateCerts: (...args: unknown[]) => runPruneMock(...args),
}));

import { POST } from '@/app/api/cron/invoicing/prune-orphaned-zero-rate-certs/route';

function makeRequest(authorization: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_AUTH = `Bearer ${CRON_SECRET}`;

describe('POST /api/cron/invoicing/prune-orphaned-zero-rate-certs — contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401 unauthorized on a MISSING Authorization header (gate before any work)', async () => {
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(runPruneMock).not.toHaveBeenCalled();
  });

  it('401 unauthorized on a WRONG Bearer token', async () => {
    const res = await POST(makeRequest('Bearer wrong-secret-deadbeef-000000000000'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(runPruneMock).not.toHaveBeenCalled();
  });

  it('500 scan_failed when the sweep reports kind:"scan_failed"', async () => {
    runPruneMock.mockResolvedValue({
      kind: 'scan_failed',
      cutoff: new Date('2026-06-30T00:00:00.000Z'),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scan_failed');
  });

  it('200 + counts on a successful sweep (kind:"ok")', async () => {
    runPruneMock.mockResolvedValue({
      kind: 'ok',
      scanned: 5,
      swept: 2,
      skipped: 3,
      cutoff: new Date('2026-06-30T00:00:00.000Z'),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      scanned: number;
      swept: number;
      skipped: number;
      cutoff: string;
    };
    expect(body.ok).toBe(true);
    expect(body.scanned).toBe(5);
    expect(body.swept).toBe(2);
    expect(body.skipped).toBe(3);
    expect(body.cutoff).toBe('2026-06-30T00:00:00.000Z');
    expect(runPruneMock).toHaveBeenCalledTimes(1);
  });

  it('500 scan_failed when the sweep THROWS unexpectedly', async () => {
    runPruneMock.mockRejectedValue(new Error('unexpected'));
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scan_failed');
  });
});
