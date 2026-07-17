/**
 * 066 §3.2(3) — lapse-cycles-on-grace-expiry per-tenant route: the
 * dormancy-guard escalation-task loop.
 *
 * /speckit-review finding (tests, important): the route's best-effort loop
 * over `deferredNoPriorWarningCycles` is the SOLE creation site of the
 * `termination_warning_blocked` escalation task — the ONLY admin-visibility
 * mechanism for the structurally-unwarnable cohort. It was exercised by NO
 * test (the dormancy-guard integration test called `createEscalationTask`
 * directly with drifted args, never through the route). This pins the route's
 * ACTUAL loop + args so a regression (deleted loop, wrong array, zod-rejected
 * args swallowed by the best-effort catch) FAILS a test instead of silently
 * deferring terminations forever with no admin work-item.
 *
 * Mirrors `enter-awaiting-payment-route.test.ts` mock scaffolding.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

const TENANT_SLUG = 'tenanta';
const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    features: { f8Renewals: true },
    flags: { readOnlyMode: false },
    tenant: { slug: 'tenanta' },
    app: { baseUrl: 'http://localhost:3100' },
    log: { level: 'silent' },
    upstash: {
      url: 'https://test.upstash.io',
      token: 'test-token-with-enough-length-for-zod-min-20',
    },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

const txExecuteMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({ execute: txExecuteMock }),
}));

const lapseMock = vi.hoisted(() => vi.fn());
const createEscalationTaskMock = vi.hoisted(() =>
  vi.fn(
    async (_deps: unknown, _input: Record<string, unknown>): Promise<void> => {},
  ),
);
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    lapseCyclesOnGraceExpiry: lapseMock,
    createEscalationTask: createEscalationTaskMock,
    makeRenewalsDeps: vi.fn(() => ({ tenant: { slug: 'tenanta' } })),
  };
});

const rateLimiterCheckMock = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, reset: 0 })),
);
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: rateLimiterCheckMock },
}));
vi.mock('@/lib/rate-limit-helpers', () => ({
  retryAfterSecondsFromRl: vi.fn(() => 42),
}));

vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    coordinatorAuditEmitFailed: vi.fn(),
    redisFallback: vi.fn(),
  },
}));

import { POST } from '@/app/api/cron/renewals/lapse-cycles-on-grace-expiry/[tenantId]/route';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}
const VALID_AUTH = { authorization: `Bearer ${CRON_SECRET}` };
const params = (tenantId: string) => ({ params: Promise.resolve({ tenantId }) });

// A full lapse result with ONE dormancy-guard deferral to drive the loop.
function lapseResult(
  deferredNoPriorWarningCycles: ReadonlyArray<{ memberId: string; cycleId: string }>,
) {
  return ok({
    cyclesProcessed: 5,
    graceExpired: 2,
    paymentFailed: 0,
    transitionRaceSkipped: 0,
    deferredInvoiceNotDue: 0,
    deferredWithinTerminationWindow: 0,
    deferredNoInvoiceBackstop: 1,
    deferredNoPriorWarning: deferredNoPriorWarningCycles.length,
    deferredGuardErrors: 0,
    errors: 0,
    deferredNoPriorWarningCycles,
  });
}

describe('cron lapse-cycles per-tenant route — §3.2(3) escalation loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a termination_warning_blocked task per deferred cycle with the route args', async () => {
    lapseMock.mockResolvedValueOnce(
      lapseResult([{ memberId: 'mem-1', cycleId: 'cyc-1' }]),
    );
    const res = await POST(makeRequest(VALID_AUTH), params(TENANT_SLUG));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(body.deferred_no_prior_warning).toBe(1);

    expect(createEscalationTaskMock).toHaveBeenCalledTimes(1);
    const arg = createEscalationTaskMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(arg).toMatchObject({
      tenantId: TENANT_SLUG,
      memberId: 'mem-1',
      cycleId: 'cyc-1',
      taskType: 'termination_warning_blocked',
      assignedToRole: 'admin',
      triggerReason: 'scheduled_cron_step',
      actorUserId: null,
      actorRole: 'cron',
    });
    // Pin the real summary so a zod/enum tightening that would be swallowed by
    // the best-effort catch fails HERE instead (the drifted H1 copy did not).
    expect(String(arg.summary)).toContain('due+60 termination deferred');
    expect(String(arg.summary)).toContain('at least 14 days old');
  });

  it('creates one task per deferred cycle (loop iterates the whole array)', async () => {
    lapseMock.mockResolvedValueOnce(
      lapseResult([
        { memberId: 'mem-1', cycleId: 'cyc-1' },
        { memberId: 'mem-2', cycleId: 'cyc-2' },
      ]),
    );
    const res = await POST(makeRequest(VALID_AUTH), params(TENANT_SLUG));
    expect(res.status).toBe(200);
    expect(createEscalationTaskMock).toHaveBeenCalledTimes(2);
    expect(
      createEscalationTaskMock.mock.calls.map((c) => (c[1] as { cycleId: string }).cycleId),
    ).toEqual(['cyc-1', 'cyc-2']);
  });

  it('no deferrals → no escalation task', async () => {
    lapseMock.mockResolvedValueOnce(lapseResult([]));
    const res = await POST(makeRequest(VALID_AUTH), params(TENANT_SLUG));
    expect(res.status).toBe(200);
    expect(createEscalationTaskMock).not.toHaveBeenCalled();
  });

  it('best-effort: an escalation-task write failure does NOT fail the cron response', async () => {
    lapseMock.mockResolvedValueOnce(
      lapseResult([{ memberId: 'mem-1', cycleId: 'cyc-1' }]),
    );
    createEscalationTaskMock.mockRejectedValueOnce(new Error('neon blip'));
    const res = await POST(makeRequest(VALID_AUTH), params(TENANT_SLUG));
    // The deferral counter/metric already recorded it; the task write is
    // swallowed (logged) so the cron pass still returns its counts.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(body.deferred_no_prior_warning).toBe(1);
  });
});
