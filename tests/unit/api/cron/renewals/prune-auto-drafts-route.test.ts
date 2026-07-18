/**
 * 107-auto-invoice Task 11 (review Critical fix) — Route-level test for
 * the prune-auto-drafts single-route daily housekeeping cron.
 *
 * Mirrors `prune-consumed-tokens-route.test.ts`'s structure exactly, plus
 * the SECOND dark-ship flag (`FEATURE_AUTO_INVOICE`) per the
 * `auto-draft-route.test.ts` two-flag precedent — this route's kill-switch
 * gate is `!env.features.f8Renewals || !env.features.autoInvoice`, so both
 * flags need their own independent 200-skipped case.
 *
 * Test matrix:
 *   1. 401 on missing Bearer + `cron_bearer_auth_rejected` audit
 *   2. 401 on wrong Bearer + audit
 *   3. 429 + Retry-After when rate-limited; NO audit
 *   4. 200 + skipped on `FEATURE_F8_RENEWALS=false`; NO metric emit
 *   5. 200 + skipped on `FEATURE_AUTO_INVOICE=false`; NO metric emit
 *   6. 200 + skipped on `READ_ONLY_MODE=true` + `coordinatorSkippedReadOnly('prune_auto_drafts')`
 *   7. Happy path: BOTH `pruneAutoDraftsRunCompleted(t,'success')` +
 *      `pruneAutoDraftsPruned(t, N)` emitted exactly once each
 *   8. Use-case returns `Result.err` → 500 + only `RunCompleted(t,'failure')`
 *   9. Use-case throws → 500 (catch path) + only `RunCompleted(t,'failure')`
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';
const TENANT_SLUG = 'tenanta';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f8Renewals: true, autoInvoice: true },
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
const pruneAutoDraftsMock = vi.hoisted(() => vi.fn());

vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: vi.fn(() => ({
    tenant: { slug: 'tenanta' },
    auditEmitter: { emit: auditEmitMock, emitInTx: vi.fn() },
  })),
  pruneAutoDrafts: pruneAutoDraftsMock,
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
const prunedMock = vi.hoisted(() => vi.fn());
const skippedReadOnlyMock = vi.hoisted(() => vi.fn());
const auditEmitFailedMock = vi.hoisted(() => vi.fn());
const redisFallbackMock = vi.hoisted(() => vi.fn());
const cronBearerAuthRejectedMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    pruneAutoDraftsRunCompleted: runCompletedMock,
    pruneAutoDraftsPruned: prunedMock,
    coordinatorSkippedReadOnly: skippedReadOnlyMock,
    coordinatorAuditEmitFailed: auditEmitFailedMock,
    redisFallback: redisFallbackMock,
    cronBearerAuthRejected: cronBearerAuthRejectedMock,
  },
}));

import { POST } from '@/app/api/cron/renewals/prune-auto-drafts/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };

describe('cron prune-auto-drafts route (107-auto-invoice Task 11)', () => {
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
      '/api/cron/renewals/prune-auto-drafts',
    );
    expect(pruneAutoDraftsMock).not.toHaveBeenCalled();
    expect(runCompletedMock).not.toHaveBeenCalled();
    expect(prunedMock).not.toHaveBeenCalled();
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
      expect(pruneAutoDraftsMock).not.toHaveBeenCalled();
      expect(runCompletedMock).not.toHaveBeenCalled();
      expect(prunedMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('200 + skipped on FEATURE_AUTO_INVOICE=false (dark-ship key #2); NO metric emit', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { autoInvoice: boolean };
    };
    env.features.autoInvoice = false;
    try {
      const res = await POST(makeRequest(VALID_AUTH));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('feature_flag_disabled');
      expect(pruneAutoDraftsMock).not.toHaveBeenCalled();
      expect(runCompletedMock).not.toHaveBeenCalled();
      expect(prunedMock).not.toHaveBeenCalled();
    } finally {
      env.features.autoInvoice = true;
    }
  });

  it('200 + skipped on READ_ONLY_MODE=true + coordinatorSkippedReadOnly("prune_auto_drafts")', async () => {
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
      expect(skippedReadOnlyMock).toHaveBeenCalledWith('prune_auto_drafts');
      expect(pruneAutoDraftsMock).not.toHaveBeenCalled();
      expect(runCompletedMock).not.toHaveBeenCalled();
      expect(prunedMock).not.toHaveBeenCalled();
    } finally {
      env.flags.readOnlyMode = false;
    }
  });

  it('SUCCESS path emits BOTH runCompleted("success") AND pruned(N) exactly once each', async () => {
    pruneAutoDraftsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        candidatesFound: 3,
        pruned: 2,
        skippedAlreadyGone: 1,
        errors: 0,
        durationMs: 88,
      },
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(body.candidates_found).toBe(3);
    expect(body.pruned).toBe(2);
    expect(body.skipped_already_gone).toBe(1);
    expect(body.errors).toBe(0);
    expect(body.tenant_id).toBe(TENANT_SLUG);

    expect(runCompletedMock).toHaveBeenCalledTimes(1);
    expect(runCompletedMock).toHaveBeenCalledWith(TENANT_SLUG, 'success');
    expect(prunedMock).toHaveBeenCalledTimes(1);
    expect(prunedMock).toHaveBeenCalledWith(TENANT_SLUG, 2);
  });

  it('mapped-error path (Result.err from use-case) → 500 + ONLY runCompleted("failure")', async () => {
    pruneAutoDraftsMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'invalid_input', message: 'simulated invalid input' },
    });
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
    expect(body.tenant_id).toBe(TENANT_SLUG);

    expect(runCompletedMock).toHaveBeenCalledTimes(1);
    expect(runCompletedMock).toHaveBeenCalledWith(TENANT_SLUG, 'failure');
    expect(prunedMock).not.toHaveBeenCalled();
  });

  it('catch path (use-case throws) → 500 + ONLY runCompleted("failure")', async () => {
    pruneAutoDraftsMock.mockRejectedValueOnce(
      new Error('connection lost before use-case returned'),
    );
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
    expect(body.tenant_id).toBe(TENANT_SLUG);

    expect(runCompletedMock).toHaveBeenCalledTimes(1);
    expect(runCompletedMock).toHaveBeenCalledWith(TENANT_SLUG, 'failure');
    expect(prunedMock).not.toHaveBeenCalled();
  });
});
