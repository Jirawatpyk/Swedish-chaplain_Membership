/**
 * F8 Phase 6 review I9 — Bearer + kill-switch + audit coverage for the
 * weekly at-risk recompute coordinator route. Mirrors the
 * dispatch-coordinator.test.ts pattern; pins the C2 fix
 * (`cron_bearer_auth_rejected` audit on the 401 path) + the I3 fix
 * (`cron_kind: 'at_risk_recompute'` discriminator on the orchestrated
 * audit) so a future refactor that drops either field fails CI.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';
const TENANT_SLUG = 'tenanta';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f8Renewals: true, f8AtRiskDisabled: false },
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
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: rateLimiterCheckMock },
}));
vi.mock('@/lib/rate-limit-helpers', () => ({
  retryAfterSecondsFromRl: vi.fn(() => 42),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// withActiveSpan added (W0-09) — mock so coordinator body executes cleanly.
vi.mock('@/lib/otel-tracer', () => ({
  renewalsTracer: () => ({}),
  withActiveSpan: async (
    _tracer: unknown,
    _name: string,
    _attrs: unknown,
    fn: (span: { setAttribute: (k: string, v: unknown) => void }) => unknown,
  ) => fn({ setAttribute: () => {} }),
}));

// W0-09: cron-auth.ts now calls renewalsMetrics.cronBearerAuthRejected on
// every 401 path. Mock the whole renewalsMetrics object so the tests do not
// require a live OTel SDK (safeMetric swallows, but mocking is cleaner).
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    cronBearerAuthRejected: vi.fn(),
    coordinatorAuditEmitFailed: vi.fn(),
    redisFallback: vi.fn(),
    coordinatorSkippedReadOnly: vi.fn(),
    coordinatorTenantsEnqueued: vi.fn(),
    coordinatorTenantsSucceeded: vi.fn(),
    coordinatorTenantsFailed: vi.fn(),
    coordinatorDurationMs: vi.fn(),
  },
}));

import { POST } from '@/app/api/cron/renewals/at-risk-recompute-coordinator/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };

describe('cron at-risk-recompute-coordinator route (Phase 6 review I9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401 on missing Bearer + emits cron_bearer_auth_rejected audit', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthorized');
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_bearer_auth_rejected');
    expect((event.payload as { route: string }).route).toBe(
      '/api/cron/renewals/at-risk-recompute-coordinator',
    );
  });

  it('401 on wrong Bearer + emits audit', async () => {
    const res = await POST(
      makeRequest({ authorization: 'Bearer wrong-secret-32-bytes-long-aaaa' }),
    );
    expect(res.status).toBe(401);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock.mock.calls[0]![0].type).toBe(
      'cron_bearer_auth_rejected',
    );
  });

  it('429 + Retry-After when bearer-rejected rate limit exceeded; NO audit', async () => {
    rateLimiterCheckMock.mockResolvedValueOnce({ success: false, reset: 0 });
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(auditEmitMock).not.toHaveBeenCalled();
  });

  it('200 + skipped on FEATURE_F8_RENEWALS=false (whole-F8 kill-switch)', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { f8Renewals: boolean };
    };
    env.features.f8Renewals = false;
    try {
      const res = await POST(makeRequest(VALID_AUTH));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('feature_flag_disabled');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('Phase 9 / T241 — 200 + skipped on READ_ONLY_MODE=true (no audit, no fan-out)', async () => {
    const env = (await import('@/lib/env')).env as {
      flags: { readOnlyMode: boolean };
    };
    env.flags.readOnlyMode = true;
    try {
      const res = await POST(makeRequest(VALID_AUTH));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('read_only_mode');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditEmitMock).not.toHaveBeenCalled();
    } finally {
      env.flags.readOnlyMode = false;
    }
  });

  it('200 + skipped on FEATURE_F8_AT_RISK_DISABLED=true (granular kill-switch FR-052b)', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { f8AtRiskDisabled: boolean };
    };
    env.features.f8AtRiskDisabled = true;
    try {
      const res = await POST(makeRequest(VALID_AUTH));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('at_risk_disabled');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8AtRiskDisabled = false;
    }
  });

  it('happy path emits cron_dispatch_orchestrated with cron_kind=at_risk_recompute (Phase 6 I3)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skipped: false,
        tenant_id: TENANT_SLUG,
        members_total: 100,
        members_recomputed: 95,
        members_skipped_below_tenure: 5,
        members_failed: 0,
        duration_ms: 1200,
      }),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_dispatch_orchestrated');
    // I3 discriminator — dashboards filter on this to distinguish
    // weekly at-risk runs from daily dispatch runs.
    expect((event.payload as { cron_kind: string }).cron_kind).toBe(
      'at_risk_recompute',
    );
  });

  it('R4-S3 — per-tenant 500 marks the tenant failed but continues + returns 200 with tenants_failed=1', async () => {
    // Per-tenant fault isolation: a per-tenant route that 500s must
    // NOT propagate up — the coordinator records the failure and
    // returns 200 so cron-job.org does not retry-storm the
    // coordinator. Mirrors the dispatch-coordinator K14-5 precedent.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: 'internal_error' } }),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants_succeeded).toBe(0);
    expect(body.tenants_failed).toBe(1);
    // Audit still emits — coordinator records the orchestration shape
    // even when every tenant pass failed (this is the operationally-
    // valuable signal for SRE).
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_dispatch_orchestrated');
    expect((event.payload as { tenants_failed: number }).tenants_failed).toBe(1);
  });
});
