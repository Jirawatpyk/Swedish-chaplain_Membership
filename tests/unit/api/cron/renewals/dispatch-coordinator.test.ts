/**
 * F8 Phase 4 Wave I5 / T103 spec — daily reminder dispatch coordinator route.
 *
 * Test scope: Bearer auth, kill-switch, fan-out summary aggregation,
 * audit emit, error isolation per fetched tenant.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const TENANT_SLUG = 'tenanta';
const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';
const BASE_URL = 'http://localhost:3100';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f8Renewals: true },
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

// K12-6 (SEC-K-5): rate-limiter mock for the new bearer-rejected
// rate-limit on the 401 path. Default success=true so existing tests
// remain unaffected; per-test override re-binds for the rate-limited
// case.
const rateLimiterCheckMock = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, reset: 0 })),
);
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: rateLimiterCheckMock },
}));
vi.mock('@/lib/rate-limit-helpers', () => ({
  retryAfterSecondsFromRl: vi.fn(() => 42),
}));

// K15-1 (R14-W1): spy on `renewalsMetrics.redisFallback` so the K14-5
// fail-open metric counter can be asserted in the K14-3 fail-open
// test. Without this assertion a future refactor that drops the
// counter call would silently break the alert pipeline (the very
// reason K14-5 was added). Other metrics methods are passed through
// unchanged.
const redisFallbackMock = vi.hoisted(() => vi.fn());
const coordinatorAuditEmitFailedMock = vi.hoisted(() => vi.fn());
const unknownResendErrorNameMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    redisFallback: redisFallbackMock,
    coordinatorAuditEmitFailed: coordinatorAuditEmitFailedMock,
    coordinatorTenantFailed: vi.fn(),
    bounceHookFailed: vi.fn(),
    resetHookFailed: vi.fn(),
    webhookSchemaRejected: vi.fn(),
    unknownResendErrorName: unknownResendErrorNameMock,
  },
}));

// Mock global fetch — coordinator fans out via fetch().
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { POST } from '@/app/api/cron/renewals/dispatch-coordinator/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
  } as unknown as NextRequest;
}

const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };

describe('cron dispatch-coordinator route (T103)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401 on missing Bearer', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthorized');
    // K12-8 (TST-K-4): pin K6 cron_bearer_auth_rejected audit emission
    // so a future refactor that drops the emit fails CI. The audit is
    // the ONLY forensic signal of sustained Bearer-rejection
    // (CRON_SECRET rotation incident, attacker probing).
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_bearer_auth_rejected');
    expect((event.payload as { route: string }).route).toBe(
      '/api/cron/renewals/dispatch-coordinator',
    );
  });

  it('401 on wrong Bearer (timing-safe)', async () => {
    const res = await POST(
      makeRequest({ authorization: 'Bearer wrong-secret-32-bytes-long-aaaa' }),
    );
    expect(res.status).toBe(401);
    // K12-8 (TST-K-4): same audit must fire on wrong-Bearer path.
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock.mock.calls[0]![0].type).toBe(
      'cron_bearer_auth_rejected',
    );
  });

  it('K12-6 (SEC-K-5): 429 + Retry-After when bearer-rejected rate limit exceeded; NO audit emitted', async () => {
    // Caps audit-DB-write amplification under brute-force probing.
    // After the limit is hit, subsequent 401s short-circuit with no
    // INSERT into audit_log — the audit signal stays at the capped
    // cadence (sufficient for forensic detection).
    rateLimiterCheckMock.mockResolvedValueOnce({ success: false, reset: 0 });
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).toBe('42');
    // No audit emit — that is the whole point of the rate-limit guard.
    expect(auditEmitMock).not.toHaveBeenCalled();
  });

  it('K14-3 (R13-W3): fail-open on Upstash outage — still returns 401 + emits cron_bearer_auth_rejected (NOT 500)', async () => {
    // K13-1 fail-open: when `rateLimiter.check` itself throws
    // (Upstash unreachable, network timeout), the route MUST proceed
    // through the audit emit and 401 — NOT cascade into a 500 that
    // would flood the F8 cron team with spurious alerts during an
    // unrelated Upstash incident. K14 closes the test gap that
    // would have allowed a future re-throw inside the catch to slip
    // past CI silently. (R13-W3 finding from senior-tester +
    // chamber-os-architect.)
    rateLimiterCheckMock.mockRejectedValueOnce(
      new Error('upstash unreachable'),
    );
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthorized');
    // Audit MUST still fire on the fail-open path so the forensic
    // trail of bearer-rejection is preserved during Upstash outages.
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock.mock.calls[0]![0].type).toBe(
      'cron_bearer_auth_rejected',
    );
    // K15-1 (R14-W1): pin the K14-5 redisFallback counter — Vercel
    // alert rules attach to OTel counters not log strings, so
    // dropping this call (regression) would silently break the
    // Upstash-outage alert pipeline. CI now catches that.
    expect(redisFallbackMock).toHaveBeenCalledTimes(1);
  });

  it('200 + skipped on FEATURE_F8_RENEWALS=false (kill-switch)', async () => {
    const env = (await import('@/lib/env')).env as { features: { f8Renewals: boolean } };
    env.features.f8Renewals = false;
    try {
      const res = await POST(makeRequest(VALID_AUTH));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('feature_flag_disabled');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditEmitMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('happy path: fans out to per-tenant route + emits audit + returns aggregated summary', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skipped: false,
        tenant_id: TENANT_SLUG,
        reminders_dispatched: 12,
        tasks_created: 2,
        duration_ms: 3200,
      }),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(body.tenants_enqueued).toBe(1);
    expect(body.tenants_succeeded).toBe(1);
    expect(body.tenants_failed).toBe(0);
    expect(body.per_tenant_results).toHaveLength(1);
    expect(body.per_tenant_results[0].tenant_id).toBe(TENANT_SLUG);
    expect(body.per_tenant_results[0].reminders_dispatched).toBe(12);
    // Fetch hit the per-tenant URL with Bearer + correlation id.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0]!;
    expect(fetchArgs[0]).toBe(
      `${BASE_URL}/api/cron/renewals/dispatch/${encodeURIComponent(TENANT_SLUG)}`,
    );
    expect(fetchArgs[1].method).toBe('POST');
    expect(fetchArgs[1].headers.Authorization).toBe(`Bearer ${CRON_SECRET}`);
    // cron_dispatch_orchestrated audit emitted.
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock.mock.calls[0]![0].type).toBe(
      'cron_dispatch_orchestrated',
    );
  });

  it('per-tenant fetch failure: counted as failed in summary, audit still emitted', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants_succeeded).toBe(0);
    expect(body.tenants_failed).toBe(1);
    expect(body.per_tenant_results[0].error).toContain('connection refused');
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
  });

  it('per-tenant fetch returns non-2xx: counted as failed (http_500)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ error: { code: 'dispatch_failed' } }),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants_failed).toBe(1);
    expect(body.per_tenant_results[0].error).toBe('http_500');
  });

  it('J5-H10: per-tenant returns 200 but JSON unparseable (Vercel HTML error page) → counted as failed, NOT silently green', async () => {
    // Previously `r.json().catch(() => ({}))` coerced parse errors
    // to `{}`, so the coordinator counted the tenant as succeeded
    // with `reminders_dispatched=0` while the dispatch had actually
    // crashed. Now: JSON parse failure routes through the failure
    // path with `kind: 'json_parse_failed'`.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      json: async () => {
        throw new Error('Unexpected token < in JSON at position 0');
      },
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants_succeeded).toBe(0);
    expect(body.tenants_failed).toBe(1);
    expect(body.per_tenant_results[0].error).toBe(
      'http_200_json_parse_failed',
    );
    // Audit emit still fires so the orchestration row records the
    // failure (Principle VIII compliance trail).
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
  });

  it('audit emit failure swallowed (does not break response)', async () => {
    auditEmitMock.mockRejectedValueOnce(new Error('audit db down'));
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skipped: false,
        tenant_id: TENANT_SLUG,
        reminders_dispatched: 1,
        tasks_created: 0,
        duration_ms: 100,
      }),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants_succeeded).toBe(1);
  });
});
