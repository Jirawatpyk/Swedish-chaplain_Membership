/**
 * #408 — the F9 snapshot-refresh COORDINATOR honours READ_ONLY_MODE.
 *
 * The coordinator is not a pure reader: `computeDashboardSnapshot` UPSERTs the
 * `dashboard_metrics_cache` row. Vercel Cron invokes it with GET every 5 min,
 * which `src/proxy.ts` never freezes, so the route must skip by itself.
 *
 * `gateCronBearerOrRespond` is mocked to PASS so the test isolates the freeze
 * branch; the freeze-OFF case pins that the refresh still runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const envMock = vi.hoisted(() => ({
  cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
  features: { f9Dashboard: true },
  flags: { readOnlyMode: false },
  tenant: { slug: 'tenanta' },
}));
vi.mock('@/lib/env', () => ({ env: envMock }));

const gateMock = vi.hoisted(() => vi.fn(async (): Promise<Response | null> => null));
vi.mock('@/lib/cron-auth', () => ({ gateCronBearerOrRespond: gateMock }));

const computeMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, value: {} })));
vi.mock('@/modules/insights', () => ({
  computeDashboardSnapshot: computeMock,
  makeComputeDashboardSnapshotDeps: () => ({}),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenanta' }),
}));
vi.mock('@/lib/metrics', () => ({
  insightsMetrics: {
    snapshotRefresh: vi.fn(),
    snapshotRefreshDurationMs: vi.fn(),
    auditEmitFailed: vi.fn(),
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET, POST } from '@/app/api/cron/insights/snapshot-refresh-coordinator/route';

function makeRequest(): NextRequest {
  return {
    headers: { get: () => 'Bearer test-secret-32-bytes-long-aaaaaa' },
  } as unknown as NextRequest;
}

describe('cron insights snapshot-refresh-coordinator — READ_ONLY_MODE (#408)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.flags.readOnlyMode = false;
    gateMock.mockResolvedValue(null);
  });

  it('freeze on → 200 skipped; the dashboard cache is not recomputed', async () => {
    envMock.flags.readOnlyMode = true;
    expect(GET).toBe(POST);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true, reason: 'read_only_mode' });
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('freeze on + the Bearer gate rejects → the gate response, not the skip', async () => {
    envMock.flags.readOnlyMode = true;
    gateMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('freeze off → the refresh runs as before', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ refreshed: 1, failed: 0 });
    expect(computeMock).toHaveBeenCalledTimes(1);
  });
});
