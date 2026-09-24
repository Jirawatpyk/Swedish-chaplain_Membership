/**
 * 0306 — route-level test for the hourly reconcile-coverage-ends cron
 * (structure mirrors `reconcile-issued-orphans-route.test.ts`).
 *
 *   1. 401 on missing Bearer (+ cron_bearer_auth_rejected audit)
 *   2. 200 skipped on FEATURE_F8_RENEWALS=false — use-case never called
 *   3. 200 skipped on READ_ONLY_MODE + coordinatorSkippedReadOnly
 *   4. Happy path → counts in the body + per-outcome metrics + age gauge
 *   5. Use-case throws → 500 + an `errored` metric (never silent)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';

const envMock = vi.hoisted(() => ({
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
}));
vi.mock('@/lib/env', () => ({ env: envMock }));

const auditEmitMock = vi.hoisted(() =>
  vi.fn(async (_event: { type: string; payload: unknown }, _ctx: unknown) => {}),
);
const reconcileMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: vi.fn(() => ({
    tenant: { slug: 'tenanta' },
    auditEmitter: { emit: auditEmitMock, emitInTx: vi.fn() },
  })),
  reconcileMembershipCoverageEnds: reconcileMock,
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: vi.fn(async () => ({ success: true, reset: 0 })) },
}));
vi.mock('@/lib/rate-limit-helpers', () => ({ retryAfterSecondsFromRl: vi.fn(() => 42) }));

const reconciledMock = vi.hoisted(() => vi.fn());
const oldestMock = vi.hoisted(() => vi.fn());
const skippedReadOnlyMock = vi.hoisted(() => vi.fn());
const runCompletedMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    coverageEndReconciled: reconciledMock,
    coverageEndOldestWaitingHours: oldestMock,
    coordinatorSkippedReadOnly: skippedReadOnlyMock,
    coverageEndReconcileRunCompleted: runCompletedMock,
    coordinatorAuditEmitFailed: vi.fn(),
    redisFallback: vi.fn(),
    cronBearerAuthRejected: vi.fn(),
  },
}));

import { POST } from '@/app/api/cron/renewals/reconcile-coverage-ends/route';
import { ok } from '@/lib/result';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}
const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };

describe('cron reconcile-coverage-ends route (0306)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.features.f8Renewals = true;
    envMock.flags.readOnlyMode = false;
  });

  it('401 on missing Bearer + audit; the use-case never runs', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    expect(auditEmitMock.mock.calls[0]![0].type).toBe('cron_bearer_auth_rejected');
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it('200 skipped when FEATURE_F8_RENEWALS is off', async () => {
    envMock.features.f8Renewals = false;
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe(true);
    expect(reconcileMock).not.toHaveBeenCalled();
    // Heartbeat still ticks, labelled — a disabled flag must not look healthy.
    expect(runCompletedMock).toHaveBeenCalledWith('tenanta', 'skipped_flag_disabled');
  });

  it('200 skipped in READ_ONLY_MODE', async () => {
    envMock.flags.readOnlyMode = true;
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect(skippedReadOnlyMock).toHaveBeenCalledWith('reconcile_coverage_ends');
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(runCompletedMock).toHaveBeenCalledWith('tenanta', 'skipped_read_only');
  });

  it('happy path → counts in the body + per-outcome metrics + oldest-waiting gauge', async () => {
    reconcileMock.mockResolvedValueOnce(
      ok({
        ended: 2,
        abandonedRefundFailed: 1,
        waiting: 3,
        lookupUnresolved: 0,
        expired: 1,
        strandedCleared: 0,
        backstopApplied: 1,
        oldestWaitingHours: 30,
        errored: 0,
      }),
    );
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ended: 2,
      refund_failed_kept: 1,
      waiting: 3,
      expired: 1,
      backstop_applied: 1,
      oldest_waiting_hours: 30,
    });
    expect(reconciledMock).toHaveBeenCalledWith('tenanta', 'expired', 1);
    expect(reconciledMock).toHaveBeenCalledWith('tenanta', 'backstop_applied', 1);
    expect(oldestMock).toHaveBeenCalledWith('tenanta', 30);
    expect(runCompletedMock).toHaveBeenCalledWith('tenanta', 'success');
  });

  it('use-case throws → 500 and an errored metric (never silent)', async () => {
    reconcileMock.mockRejectedValueOnce(new Error('db down'));
    const res = await POST(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);
    expect(reconciledMock).toHaveBeenCalledWith('tenanta', 'errored', 1);
    expect(runCompletedMock).toHaveBeenCalledWith('tenanta', 'failure');
  });
});
