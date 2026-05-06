/**
 * F8 Phase 4 Wave I5 / T104 spec — per-tenant reminder dispatch route.
 *
 * Test scope: Bearer auth, kill-switch, tenantId guard, advisory lock
 * SQL invocation, dispatch + retry summary, error path 500.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const TENANT_SLUG = 'tenanta';
// (uppercase 'tenantA' fails the [a-z0-9-]{1,63} TenantContext brand)
const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f8Renewals: true },
    tenant: { slug: 'tenanta' },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

const txExecuteMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({ execute: txExecuteMock }),
}));

const dispatchMock = vi.hoisted(() => vi.fn());
const retryMock = vi.hoisted(() => vi.fn());
// K12-8 (TST-K-4): wire audit-emitter mock so the new
// cron_bearer_auth_rejected audit emission on the per-tenant 401
// path is testable.
const auditEmitMock = vi.hoisted(() =>
  vi.fn(async (_event: { type: string; payload: unknown }, _ctx: unknown) => {}),
);
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    dispatchRenewalCycle: dispatchMock,
    retryFailedReminders: retryMock,
    makeRenewalsDeps: vi.fn(() => ({
      tenant: { slug: 'tenanta' },
      auditEmitter: { emit: auditEmitMock, emitInTx: vi.fn() },
    })),
  };
});

// K12-6 (SEC-K-5): mock the bearer-rejected rate-limiter (default
// success=true so existing tests are unaffected; per-test override
// re-binds for the rate-limited case).
const rateLimiterCheckMock = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, reset: 0 })),
);
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: rateLimiterCheckMock },
}));
vi.mock('@/lib/rate-limit-helpers', () => ({
  retryAfterSecondsFromRl: vi.fn(() => 42),
}));

import { POST } from '@/app/api/cron/renewals/dispatch/[tenantId]/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
  } as unknown as NextRequest;
}

const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };

const validParams = { params: Promise.resolve({ tenantId: TENANT_SLUG }) };

describe('cron per-tenant dispatch route (T104)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchMock.mockResolvedValue(
      ok({
        summary: {
          candidatesProcessed: 5,
          emailsSent: 3,
          tasksCreated: 1,
          skipped: { already_sent: 1, member_archived: 0 } as Record<string, number>,
          failedTransient: 0,
          failedPermanent: 0,
          durationMs: 1200,
        },
      }),
    );
    retryMock.mockResolvedValue(
      ok({
        summary: {
          retryEligibleProcessed: 0,
          retrySucceeded: 0,
          retryStillTransient: 0,
          retryBecamePermanent: 0,
          retryBlockedByGate: 0,
          exhaustedMarked: 0,
          passErrors: 0,
          durationMs: 50,
        },
      }),
    );
  });

  it('401 on missing Bearer', async () => {
    const res = await POST(makeRequest({}), validParams);
    expect(res.status).toBe(401);
    // K13-6 (TST-R12-2): pin error.code === 'unauthorized' (matches
    // coordinator-route assertion symmetry).
    const body = await res.json();
    expect(body.error.code).toBe('unauthorized');
    // K12-8 (TST-K-4): per-tenant route now also emits
    // cron_bearer_auth_rejected on 401 so per-tenant probing leaves
    // a forensic trail (consistency with coordinator route).
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const event = auditEmitMock.mock.calls[0]![0];
    expect(event.type).toBe('cron_bearer_auth_rejected');
    expect((event.payload as { route: string }).route).toBe(
      '/api/cron/renewals/dispatch/[tenantId]',
    );
  });

  it('401 on wrong Bearer', async () => {
    const res = await POST(
      makeRequest({ authorization: 'Bearer wrong-secret-32-bytes-long-aaaa' }),
      validParams,
    );
    expect(res.status).toBe(401);
    // K12-8 (TST-K-4): same audit must fire on wrong-Bearer path.
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock.mock.calls[0]![0].type).toBe(
      'cron_bearer_auth_rejected',
    );
  });

  it('K12-6 (SEC-K-5): 429 + Retry-After when bearer-rejected rate limit exceeded; NO audit emitted', async () => {
    rateLimiterCheckMock.mockResolvedValueOnce({ success: false, reset: 0 });
    const res = await POST(makeRequest({}), validParams);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(auditEmitMock).not.toHaveBeenCalled();
  });

  it('K14-3 (R13-W3): fail-open on Upstash outage — still returns 401 + emits cron_bearer_auth_rejected (NOT 500)', async () => {
    // K13-1 fail-open per-tenant route mirror: Upstash throw must
    // route through audit emit + 401, not cascade to 500. R13-W3
    // closure for the second cron route.
    rateLimiterCheckMock.mockRejectedValueOnce(
      new Error('upstash unreachable'),
    );
    const res = await POST(makeRequest({}), validParams);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthorized');
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    expect(auditEmitMock.mock.calls[0]![0].type).toBe(
      'cron_bearer_auth_rejected',
    );
    expect(
      (auditEmitMock.mock.calls[0]![0].payload as { route: string }).route,
    ).toBe('/api/cron/renewals/dispatch/[tenantId]');
  });

  it('200 + skipped on FEATURE_F8_RENEWALS=false', async () => {
    const env = (await import('@/lib/env')).env as { features: { f8Renewals: boolean } };
    env.features.f8Renewals = false;
    try {
      const res = await POST(makeRequest(VALID_AUTH), validParams);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('feature_flag_disabled');
      expect(dispatchMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('400 on unknown tenantId (path-traversal defence)', async () => {
    const res = await POST(makeRequest(VALID_AUTH), {
      params: Promise.resolve({ tenantId: 'wrong-tenant' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('unknown_tenant');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('happy path: acquires advisory lock + invokes dispatch + retry + returns summary', async () => {
    const res = await POST(makeRequest(VALID_AUTH), validParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(body.tenant_id).toBe(TENANT_SLUG);
    expect(body.reminders_dispatched).toBe(3);
    expect(body.tasks_created).toBe(1);
    expect(body.candidates_processed).toBe(5);
    // Advisory lock SQL was executed.
    expect(txExecuteMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(retryMock).toHaveBeenCalledTimes(1);
  });

  it('500 when dispatchRenewalCycle returns invalid_input error', async () => {
    dispatchMock.mockResolvedValueOnce(
      err({ kind: 'invalid_input', message: 'bad input' }),
    );
    const res = await POST(makeRequest(VALID_AUTH), validParams);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('dispatch_failed');
    // retry MUST NOT run when dispatch failed.
    expect(retryMock).not.toHaveBeenCalled();
  });

  it('J2-B5: retry pass err Result is logged + flagged in response (NOT silently 0-coerced)', async () => {
    retryMock.mockResolvedValueOnce(
      err({ kind: 'invalid_input', message: 'bad input' }),
    );
    const res = await POST(makeRequest(VALID_AUTH), validParams);
    // Stays 200 to avoid cron-job.org retry storms — dispatch already
    // succeeded and we don't want duplicate dispatch attempts.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reminders_retried).toBe(0);
    expect(body.reminders_exhausted).toBe(0);
    expect(body.reminders_dispatched).toBe(3);
    // J2-B5 critical: retry-pass health surfaced for coordinator audit
    // + ops dashboards. Without these flags a coordinator audit would
    // show "succeeded" while retry pass had silently no-op'd.
    expect(body.retry_pass_failed).toBe(true);
    expect(body.retry_pass_error).toBe('invalid_input');
  });

  it('unexpected throw inside tx returns 500 + server_error code', async () => {
    dispatchMock.mockRejectedValueOnce(new Error('db: connection lost'));
    const res = await POST(makeRequest(VALID_AUTH), validParams);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });

  it('emits dispatch + retry summary fields in response body', async () => {
    const res = await POST(makeRequest(VALID_AUTH), validParams);
    const body = await res.json();
    expect(body).toMatchObject({
      skipped: false,
      tenant_id: TENANT_SLUG,
      reminders_dispatched: 3,
      tasks_created: 1,
      candidates_processed: 5,
      reminders_failed_transient: 0,
      reminders_failed_permanent: 0,
      reminders_retried: 0,
      reminders_exhausted: 0,
      // J2-B5: explicit retry-health flags on happy path too.
      retry_pass_failed: false,
      retry_pass_error: null,
    });
  });
});
