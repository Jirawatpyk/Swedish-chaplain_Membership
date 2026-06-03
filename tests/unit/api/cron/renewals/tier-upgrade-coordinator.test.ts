/**
 * W0-09 — first test coverage for the tier-upgrade-evaluate coordinator route.
 *
 * Added alongside the W0-09 observability wiring: this route gained a
 * `withActiveSpan` wrapper + the § 23.1.3 coordinator metrics (tenants_
 * enqueued/succeeded/failed + duration_ms) but had NO test suite. This pins
 * the auth gate, the kill-switch skip, the `cron_kind: 'tier_upgrade_evaluate'`
 * orchestrated-audit discriminator, and — critically — that a per-tenant
 * failure increments `renewals.coordinator.tenants_failed_total` (F8-A1).
 * Mirrors at-risk-coordinator.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';
const TENANT_SLUG = 'tenanta';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f8Renewals: true },
    flags: { readOnlyMode: false },
    tenant: { slug: 'tenanta' },
    app: { baseUrl: 'http://localhost:3100' },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

const auditEmitMock = vi.hoisted(() =>
  vi.fn(async (_event: { type: string; payload: unknown }, _ctx: unknown) => {}),
);
vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: vi.fn(() => ({
    tenant: { slug: 'tenanta' },
    auditEmitter: { emit: auditEmitMock, emitInTx: vi.fn() },
  })),
}));

const rateLimiterCheckMock = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, reset: 0 })),
);
vi.mock('@/lib/auth-deps', () => ({ rateLimiter: { check: rateLimiterCheckMock } }));
vi.mock('@/lib/rate-limit-helpers', () => ({ retryAfterSecondsFromRl: vi.fn(() => 42) }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('@/lib/otel-tracer', () => ({
  renewalsTracer: () => ({}),
  withActiveSpan: async (
    _tracer: unknown,
    _name: string,
    _attrs: unknown,
    fn: (span: { setAttribute: (k: string, v: unknown) => void }) => unknown,
  ) => fn({ setAttribute: () => {} }),
}));

const coordinatorTenantsFailedMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    cronBearerAuthRejected: vi.fn(),
    coordinatorAuditEmitFailed: vi.fn(),
    redisFallback: vi.fn(),
    coordinatorSkippedReadOnly: vi.fn(),
    coordinatorTenantsEnqueued: vi.fn(),
    coordinatorTenantsSucceeded: vi.fn(),
    coordinatorTenantsFailed: coordinatorTenantsFailedMock,
    coordinatorDurationMs: vi.fn(),
  },
}));

import { POST } from '@/app/api/cron/renewals/tier-upgrade-evaluate-coordinator/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return { headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } } as unknown as NextRequest;
}
const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };

describe('cron tier-upgrade-evaluate-coordinator route (W0-09)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 on missing Bearer + emits cron_bearer_auth_rejected audit', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock.mock.calls[0]![0].type).toBe('cron_bearer_auth_rejected');
  });

  it('200 + skipped on FEATURE_F8_RENEWALS=false', async () => {
    const env = (await import('@/lib/env')).env as { features: { f8Renewals: boolean } };
    env.features.f8Renewals = false;
    try {
      const res = await POST(makeRequest(VALID_AUTH));
      expect(res.status).toBe(200);
      expect((await res.json()).reason).toBe('feature_flag_disabled');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('happy path → 200, cron_kind=tier_upgrade_evaluate, no tenants_failed metric', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ skipped: false, tenant_id: TENANT_SLUG, duration_ms: 800 }),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_dispatch_orchestrated');
    expect((event.payload as { cron_kind: string }).cron_kind).toBe('tier_upgrade_evaluate');
    expect(coordinatorTenantsFailedMock).not.toHaveBeenCalled();
  });

  it('per-tenant 500 → 200 with tenants_failed=1 AND emits F8-A1 tenants_failed metric', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: 'internal_error' } }),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect((await res.json()).tenants_failed).toBe(1);
    // F8-A1 (the alert this finding restores) — the failed counter MUST fire.
    expect(coordinatorTenantsFailedMock).toHaveBeenCalledWith('tier_upgrade_evaluate', 1);
  });
});
