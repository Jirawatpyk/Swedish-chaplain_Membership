/**
 * F9 review-round (post-ship review) — `snapshot-refresh/[tenantId]` MVP
 * single-tenant identity guard.
 *
 * The cron caller holds CRON_SECRET, but the URL `tenantId` is attacker-shaped.
 * Without the `tenantId === env.tenant.slug` guard a valid-Bearer caller could
 * refresh (and inject a `dashboard_metrics_cache` row for) an arbitrary tenant
 * name — a cross-tenant write once MTA is live. This pins the guard so a future
 * refactor that drops it fails CI. Mirrors the F8 at-risk-recompute guard.
 *
 * `gateCronBearerOrRespond` is mocked to PASS (returns null) so the test
 * isolates the tenant-identity branch, not the Bearer/rate-limit path.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f9Dashboard: true },
    tenant: { slug: 'tenanta' },
  },
}));

// Auth gate passes (returns null) — we are testing the tenant-identity branch.
const gateMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/lib/cron-auth', () => ({ gateCronBearerOrRespond: gateMock }));

const computeMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, value: { counts: { total: 0 } } })),
);
const makeDepsMock = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('@/modules/insights', () => ({
  computeDashboardSnapshot: computeMock,
  makeComputeDashboardSnapshotDeps: makeDepsMock,
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

import { POST } from '@/app/api/cron/insights/snapshot-refresh/[tenantId]/route';

function makeRequest(): NextRequest {
  return {
    headers: { get: () => 'Bearer test-secret-32-bytes-long-aaaaaa' },
  } as unknown as NextRequest;
}

function ctxFor(tenantId: string) {
  return { params: Promise.resolve({ tenantId }) };
}

describe('cron snapshot-refresh/[tenantId] — MVP single-tenant identity guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('400 unknown_tenant when URL tenantId !== configured tenant — compute NOT invoked', async () => {
    const res = await POST(makeRequest(), ctxFor('attacker-tenant'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('unknown_tenant');
    // The cross-tenant refresh must never reach the compute/upsert.
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('200 refreshed when URL tenantId matches the configured tenant', async () => {
    const res = await POST(makeRequest(), ctxFor('tenanta'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshed).toBe(true);
    expect(computeMock).toHaveBeenCalledTimes(1);
  });

  it('200 skipped (feature_disabled) gate runs before the tenant check', async () => {
    const env = (await import('@/lib/env')).env as { features: { f9Dashboard: boolean } };
    env.features.f9Dashboard = false;
    try {
      const res = await POST(makeRequest(), ctxFor('attacker-tenant'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('feature_disabled');
      expect(computeMock).not.toHaveBeenCalled();
    } finally {
      env.features.f9Dashboard = true;
    }
  });
});
