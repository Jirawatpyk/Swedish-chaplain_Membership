/**
 * F8 Round-5 review-finding M1 — bearer + kill-switch + audit coverage
 * for the daily lapse-cycles-on-grace-expiry coordinator route. Mirrors
 * `at-risk-coordinator.test.ts` structure so a future refactor that
 * drops the C2 bearer-rejection audit, the H3 cron_kind label, or the
 * H1 `error: 'fetch_rejected'` PII redaction fails CI uniformly across
 * all 3 F8 cron coordinators.
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
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: rateLimiterCheckMock },
}));
vi.mock('@/lib/rate-limit-helpers', () => ({
  retryAfterSecondsFromRl: vi.fn(() => 42),
}));

// withActiveSpan is a thin tracer wrapper; the body must execute, so
// the mock just invokes the callback with a no-op span.
vi.mock('@/lib/otel-tracer', () => ({
  renewalsTracer: () => ({}),
  withActiveSpan: async (
    _tracer: unknown,
    _name: string,
    _attrs: unknown,
    fn: (span: { setAttribute: (k: string, v: unknown) => void }) => unknown,
  ) => fn({ setAttribute: () => {} }),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { POST } from '@/app/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };

describe('cron lapse-cycles-on-grace-expiry-coordinator route (Round-5 M1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401 on missing Bearer + emits cron_bearer_auth_rejected audit (Round-4 C2)', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthorized');
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_bearer_auth_rejected');
    expect((event.payload as { route: string }).route).toBe(
      '/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator',
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

  it('200 + skipped on FEATURE_F8_RENEWALS=false (kill-switch)', async () => {
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

  it('happy path emits cron_dispatch_orchestrated with cron_kind=lapse (Round-4 H3)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skipped: false,
        tenant_id: TENANT_SLUG,
        cycles_processed: 5,
        grace_expired: 3,
        payment_failed: 2,
        transition_race_skipped: 0,
        errors: 0,
        duration_ms: 800,
      }),
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_dispatch_orchestrated');
    // Round-4 H3 discriminator — SRE telemetry filters on this to
    // distinguish daily lapse runs from at-risk / dispatch / reconcile.
    expect((event.payload as { cron_kind: string }).cron_kind).toBe(
      'lapse',
    );
  });

  it('per-tenant 500 → tenants_failed=1 + audit still emits + body 200 (fault isolation)', async () => {
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
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
  });

  it('per-tenant fetch rejection → audit-row error="fetch_rejected" (Round-5 H1 PII redaction)', async () => {
    // Round-5 H1 lock-in: a rejected internal fetch must NOT persist
    // `String(r.reason)` (which can carry DB connection strings or
    // stack frames) into immutable audit_log rows. The coordinator
    // logs the raw reason via pino but the audit-row `error` field
    // must be the fixed taxonomy literal `'fetch_rejected'`.
    fetchMock.mockRejectedValue(
      new Error('connection terminated due to timeout — host=ep-bold-pine-xxx.aws.neon.tech password=hunter2'),
    );
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants_failed).toBe(1);
    expect(body.per_tenant_results[0].error).toBe('fetch_rejected');
    // PII — connection string / password fragment must NOT appear
    // anywhere in the response payload (which the audit captures).
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain('hunter2');
    expect(bodyText).not.toContain('aws.neon.tech');
  });
});
