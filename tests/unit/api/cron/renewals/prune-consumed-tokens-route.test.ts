/**
 * F8 Phase 9 retrofit (PR #25 R3 review-fix H1) — Route-level test for
 * the prune-consumed-tokens single-route weekly housekeeping cron.
 *
 * Closes the coverage gap surfaced by R3 /review pr-test-analyzer
 * (G2 HIGH): the route handler has 3 distinct metric-emit paths
 * (success → 2 emits, mapped-error → 1, catch → 1), yet only the
 * underlying use-case was tested. A future PR collapsing the two
 * success-path emits into one would silently flatline the
 * `renewals_prune_consumed_tokens_rows_deleted_total` counter — every
 * existing test would still pass.
 *
 * Test matrix (mirror reconcile-coordinator.test.ts structure):
 *   1. 401 on missing Bearer + `cron_bearer_auth_rejected` audit
 *   2. 401 on wrong Bearer + audit
 *   3. 429 + Retry-After when rate-limited; NO audit
 *   4. 200 + skipped on `FEATURE_F8_RENEWALS=false`; NO metric emit
 *   5. 200 + skipped on `READ_ONLY_MODE=true` + `coordinatorSkippedReadOnly`
 *   6. Happy path: BOTH `pruneConsumedTokensRunCompleted(t,'success')`
 *      + `pruneConsumedTokensRowsPruned(t, N)` emitted exactly once each
 *   7. Use-case returns `Result.err` → 500 + only `RunCompleted(t,'failure')`
 *   8. Use-case throws → 500 (catch path) + only `RunCompleted(t,'failure')`
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
const pruneConsumedTokensMock = vi.hoisted(() => vi.fn());

vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: vi.fn(() => ({
    tenant: { slug: 'tenanta' },
    auditEmitter: { emit: auditEmitMock, emitInTx: vi.fn() },
  })),
  pruneConsumedTokens: pruneConsumedTokensMock,
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

const runCompletedMock = vi.hoisted(() => vi.fn());
const rowsPrunedMock = vi.hoisted(() => vi.fn());
const skippedReadOnlyMock = vi.hoisted(() => vi.fn());
const auditEmitFailedMock = vi.hoisted(() => vi.fn());
const redisFallbackMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    pruneConsumedTokensRunCompleted: runCompletedMock,
    pruneConsumedTokensRowsPruned: rowsPrunedMock,
    coordinatorSkippedReadOnly: skippedReadOnlyMock,
    coordinatorAuditEmitFailed: auditEmitFailedMock,
    redisFallback: redisFallbackMock,
  },
}));

import { POST } from '@/app/api/cron/renewals/prune-consumed-tokens/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };

describe('cron prune-consumed-tokens route (R3 H1)', () => {
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
      '/api/cron/renewals/prune-consumed-tokens',
    );
    expect(pruneConsumedTokensMock).not.toHaveBeenCalled();
    expect(runCompletedMock).not.toHaveBeenCalled();
    expect(rowsPrunedMock).not.toHaveBeenCalled();
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

  it('429 + Retry-After when bearer-rejected rate-limit exceeded; NO audit', async () => {
    rateLimiterCheckMock.mockResolvedValueOnce({ success: false, reset: 0 });
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(auditEmitMock).not.toHaveBeenCalled();
  });

  it('200 + skipped on FEATURE_F8_RENEWALS=false (kill-switch); NO metric emit', async () => {
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
      expect(pruneConsumedTokensMock).not.toHaveBeenCalled();
      expect(runCompletedMock).not.toHaveBeenCalled();
      expect(rowsPrunedMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('200 + skipped on READ_ONLY_MODE=true + coordinatorSkippedReadOnly("prune_consumed_tokens")', async () => {
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
      expect(skippedReadOnlyMock).toHaveBeenCalledTimes(1);
      expect(skippedReadOnlyMock).toHaveBeenCalledWith('prune_consumed_tokens');
      expect(pruneConsumedTokensMock).not.toHaveBeenCalled();
      expect(runCompletedMock).not.toHaveBeenCalled();
      expect(rowsPrunedMock).not.toHaveBeenCalled();
    } finally {
      env.flags.readOnlyMode = false;
    }
  });

  it('SUCCESS path emits BOTH runCompleted("success") AND rowsPruned(N) exactly once each', async () => {
    pruneConsumedTokensMock.mockResolvedValueOnce({
      ok: true,
      value: {
        pruned: 42,
        cutoffIso: '2026-03-12T00:00:00.000Z',
        durationMs: 88,
      },
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(body.pruned).toBe(42);
    expect(body.cutoff_iso).toBe('2026-03-12T00:00:00.000Z');
    expect(body.tenant_id).toBe(TENANT_SLUG);

    // Pin BOTH emits + their arg shapes — the entire point of R3 H1.
    expect(runCompletedMock).toHaveBeenCalledTimes(1);
    expect(runCompletedMock).toHaveBeenCalledWith(TENANT_SLUG, 'success');
    expect(rowsPrunedMock).toHaveBeenCalledTimes(1);
    expect(rowsPrunedMock).toHaveBeenCalledWith(TENANT_SLUG, 42);
  });

  it('mapped-error path (Result.err from use-case) → 500 + ONLY runCompleted("failure")', async () => {
    pruneConsumedTokensMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'server_error', message: 'simulated DB outage' },
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
    expect(body.tenant_id).toBe(TENANT_SLUG);

    // Pin: ONLY runCompleted with 'failure'; rowsPruned NOT called.
    expect(runCompletedMock).toHaveBeenCalledTimes(1);
    expect(runCompletedMock).toHaveBeenCalledWith(TENANT_SLUG, 'failure');
    expect(rowsPrunedMock).not.toHaveBeenCalled();
  });

  it('catch path (use-case throws) → 500 + ONLY runCompleted("failure")', async () => {
    pruneConsumedTokensMock.mockRejectedValueOnce(
      new Error('connection lost before use-case returned'),
    );
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
    expect(body.tenant_id).toBe(TENANT_SLUG);

    // Pin: only runCompleted with 'failure'; rowsPruned NOT called.
    expect(runCompletedMock).toHaveBeenCalledTimes(1);
    expect(runCompletedMock).toHaveBeenCalledWith(TENANT_SLUG, 'failure');
    expect(rowsPrunedMock).not.toHaveBeenCalled();
  });
});
