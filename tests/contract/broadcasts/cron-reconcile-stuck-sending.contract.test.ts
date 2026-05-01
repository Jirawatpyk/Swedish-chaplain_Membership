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

  it('kill-switch off → 503 feature_disabled', async () => {
    envMock.features.f7Broadcasts = false;
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reconcile-stuck-sending/route'
    );
    const res = await POST(
      makeRequest({ auth: 'Bearer test-cron-secret' }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('feature_disabled');
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

  it('valid bearer + use-case returns gateway_error → 200 + counter (does NOT escalate to 500)', async () => {
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.gateway_error).toBe(1);
    expect(body.uncaught_error).toBe(0);
  });
});
