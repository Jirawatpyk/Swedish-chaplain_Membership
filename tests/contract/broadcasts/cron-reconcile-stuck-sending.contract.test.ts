/**
 * TEST-2 — Contract test: POST /api/cron/broadcasts/reconcile-stuck-sending.
 *
 * Wire-contract surfaces:
 *   - missing Authorization header                 → 401 unauthorized
 *   - wrong Bearer token                           → 401 unauthorized
 *   - kill-switch off (FEATURE_F7_BROADCASTS=false) → 503 feature_disabled
 *   - valid bearer + no eligible rows              → 200 + zeroed summary
 *   - valid bearer + use-case raises uncaught_error → 500 (review ERR-M1)
 *
 * Per-row reconciliation behavior is covered by the use-case unit tests
 * (`tests/unit/broadcasts/application/reconcile-stuck-sending.test.ts`).
 * This test only locks the route shell auth + kill-switch + tick-level
 * status code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const reconcileStuckSendingMock = vi.fn();
const runInTenantMock = vi.fn();
// speckit-review I-1 — the route also runs the two batch sweeps after the
// single-audience reconcile loop; mock them so their wiring + best-effort
// "200 even if the sweep throws" escalation can be asserted at the route.
const sweepBatchCompletionMock = vi.fn();
const sweepAutoRetryFailedBatchesMock = vi.fn();

const ZEROED_ROLLUP = {
  scanned: 0,
  sentCount: 0,
  partialCount: 0,
  inProgressCount: 0,
  errorCount: 0,
};
const ZEROED_AUTO_RETRY = {
  eligibleCount: 0,
  retriedCount: 0,
  errorCount: 0,
  outcomes: [],
};

const envMock = {
  features: { f7Broadcasts: true },
  cron: { secret: 'test-cron-secret' },
  tenant: { slug: 'test-tenant' },
};

vi.mock('@/lib/env', () => ({
  env: envMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: (...args: unknown[]) => runInTenantMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant' }),
}));
vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug }),
}));
vi.mock('@/modules/broadcasts', () => ({
  asBroadcastId: (raw: string) => raw,
  reconcileStuckSending: (...args: unknown[]) =>
    reconcileStuckSendingMock(...args),
  makeReconcileStuckSendingDeps: () => ({}),
  // speckit-review I-1 — batch sweep arms (previously absent from the mock,
  // so they threw `undefined is not a function` and were swallowed; now
  // mockable so the wiring + 200-on-throw behavior is asserted explicitly).
  sweepAutoRetryFailedBatches: (...args: unknown[]) =>
    sweepAutoRetryFailedBatchesMock(...args),
  makeAutoRetryFailedBatchesDeps: () => ({}),
  sweepBatchCompletion: (...args: unknown[]) =>
    sweepBatchCompletionMock(...args),
  makeRollUpBatchBroadcastDeps: () => ({}),
}));

function makeRequest(opts: { auth?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) {
    headers['authorization'] = opts.auth;
  }
  return new NextRequest(
    'http://localhost/api/cron/broadcasts/reconcile-stuck-sending',
    {
      method: 'POST',
      headers,
    },
  );
}

beforeEach(() => {
  envMock.features.f7Broadcasts = true;
  reconcileStuckSendingMock.mockReset();
  runInTenantMock.mockReset();
  // Default: both batch sweeps succeed with a zeroed summary so the
  // single-audience reconcile assertions in the other tests are unaffected.
  sweepBatchCompletionMock.mockReset();
  sweepBatchCompletionMock.mockResolvedValue({ ...ZEROED_ROLLUP });
  sweepAutoRetryFailedBatchesMock.mockReset();
  sweepAutoRetryFailedBatchesMock.mockResolvedValue({ ...ZEROED_AUTO_RETRY });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cron reconcile-stuck-sending — wire contract', () => {
  it('missing Authorization → 401 unauthorized', async () => {
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reconcile-stuck-sending/route'
    );
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthorized');
    // No DB query attempted on rejected auth.
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(reconcileStuckSendingMock).not.toHaveBeenCalled();
  });

  it('wrong Bearer token → 401 unauthorized', async () => {
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reconcile-stuck-sending/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(reconcileStuckSendingMock).not.toHaveBeenCalled();
  });

  it('kill-switch off → 200 + {skipped:true, reason:feature_disabled}', async () => {
    // Verify-fix R6 (2026-05-02): kill-switch returns 200 + skipped:true
    // (parity with dispatch + prune routes) to prevent cron-job.org
    // retry-storm during dark-launch periods. Was 503 pre-R6.
    envMock.features.f7Broadcasts = false;
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reconcile-stuck-sending/route'
    );
    const res = await POST(
      makeRequest({ auth: 'Bearer test-cron-secret' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skipped?: boolean;
      reason?: string;
    };
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('feature_disabled');
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(reconcileStuckSendingMock).not.toHaveBeenCalled();
  });

  it('valid bearer + no eligible rows → 200 + zeroed summary', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) => fn({
      execute: async () => [],
    }));
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reconcile-stuck-sending/route'
    );
    const res = await POST(
      makeRequest({ auth: 'Bearer test-cron-secret' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.processed).toBe(0);
    expect(body.reconciled_sent).toBe(0);
    expect(body.uncaught_error).toBe(0);
    expect(reconcileStuckSendingMock).not.toHaveBeenCalled();
  });

  it('valid bearer + use-case throws → 500 (review ERR-M1 escalation)', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) => fn({
      execute: async () => [{ broadcast_id: 'b1' }],
    }));
    reconcileStuckSendingMock.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reconcile-stuck-sending/route'
    );
    const res = await POST(
      makeRequest({ auth: 'Bearer test-cron-secret' }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, number>;
    expect(body.uncaught_error).toBeGreaterThan(0);
  });

  it('valid bearer + reconciled_sent outcome → 200 + counter increment', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) => fn({
      execute: async () => [{ broadcast_id: 'b1' }, { broadcast_id: 'b2' }],
    }));
    reconcileStuckSendingMock
      .mockResolvedValueOnce(
        ok({
          kind: 'reconciled_sent',
          broadcastId: 'b1',
          sentAt: new Date(),
          quotaYear: 2026,
        }),
      )
      .mockResolvedValueOnce(
        ok({
          kind: 'not_stuck_yet',
          broadcastId: 'b2',
          observedStatus: 'sending',
        }),
      );
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reconcile-stuck-sending/route'
    );
    const res = await POST(
      makeRequest({ auth: 'Bearer test-cron-secret' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.processed).toBe(2);
    expect(body.reconciled_sent).toBe(1);
    expect(body.not_stuck_yet).toBe(1);
    expect(body.uncaught_error).toBe(0);
  });

  it('valid bearer + use-case returns gateway_error → 200 + dedicated outage log (review ERR-H-R3-2)', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) => fn({
      execute: async () => [{ broadcast_id: 'b1' }],
    }));
    reconcileStuckSendingMock.mockResolvedValueOnce(
      err({ kind: 'reconcile.gateway_error', cause: 'resend 503' }),
    );
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reconcile-stuck-sending/route'
    );
    const res = await POST(
      makeRequest({ auth: 'Bearer test-cron-secret' }),
    );
    // Review ERR-H-R3-2 (round 3): gateway_error returns 200 — the
    // per-row work was already done idempotently; the next 15-min tick
    // is the natural retry. cron-job.org would otherwise hammer the
    // endpoint during a Resend outage, wasting compute and emitting
    // duplicate audit rows. The dedicated `gateway_outage` log + per-
    // tenant `dedupeKey` lets the alert pipeline page on the outage
    // without using HTTP status as the trigger.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.gateway_error).toBe(1);
    expect(body.uncaught_error).toBe(0);
  });

  it('valid bearer + use-case returns server_error → 500 escalation (review TEST-G2)', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) => fn({
      execute: async () => [{ broadcast_id: 'b1' }],
    }));
    reconcileStuckSendingMock.mockResolvedValueOnce(
      err({ kind: 'reconcile.server_error', message: 'transition guard failed' }),
    );
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reconcile-stuck-sending/route'
    );
    const res = await POST(
      makeRequest({ auth: 'Bearer test-cron-secret' }),
    );
    // server_error is a Result.err from the use-case (transient DB
    // blip, transition guard violation, etc.) — harness retry is
    // appropriate. Distinct from gateway_error which is bounded by
    // the per-row try/catch + handled idempotently next tick.
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, number>;
    expect(body.server_error).toBe(1);
    expect(body.gateway_error).toBe(0);
    expect(body.uncaught_error).toBe(0);
  });

  // speckit-review I-1 — the batch-completion roll-up sweep (Ship-blocker A's
  // only production entry point) + the auto-retry sweep are wired into this
  // route AFTER the single-audience loop, each in a best-effort try/catch.
  // A sweep throw must NOT 500 the tick (the next 15-min tick re-picks it);
  // these pin both the wiring and that 200-on-throw escalation choice.

  it('valid bearer + sweepBatchCompletion throws → still 200 (best-effort, not 500) (speckit-review I-1)', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [] }),
    );
    sweepBatchCompletionMock.mockRejectedValueOnce(new Error('rollup boom'));
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reconcile-stuck-sending/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    // Wiring proof — the roll-up sweep was actually invoked by the route,
    // and the auto-retry sweep ran first (independent arms; the roll-up
    // throwing doesn't unwind the already-completed auto-retry arm).
    expect(sweepAutoRetryFailedBatchesMock).toHaveBeenCalledTimes(1);
    expect(sweepBatchCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('valid bearer + sweepAutoRetryFailedBatches throws → still 200 (best-effort, not 500) (speckit-review I-1)', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [] }),
    );
    sweepAutoRetryFailedBatchesMock.mockRejectedValueOnce(
      new Error('auto-retry boom'),
    );
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reconcile-stuck-sending/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(sweepAutoRetryFailedBatchesMock).toHaveBeenCalledTimes(1);
    // The roll-up sweep still runs even after the auto-retry sweep threw
    // (independent try/catch blocks — one failing arm doesn't skip the next).
    expect(sweepBatchCompletionMock).toHaveBeenCalledTimes(1);
  });
});
