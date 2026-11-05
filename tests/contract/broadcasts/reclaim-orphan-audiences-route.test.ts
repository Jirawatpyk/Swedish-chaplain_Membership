/**
 * Contract test: POST /api/cron/broadcasts/reclaim-orphan-audiences.
 *
 * Wire-contract surfaces:
 *   - missing Authorization header          → 401 unauthorized
 *   - wrong Bearer token                    → 401 unauthorized
 *   - valid bearer + no orphans             → 200 + { scanned, orphaned, deleted, failed, skippedNonMatching }
 *   - valid bearer + use-case ok result     → 200 + aggregated shape
 *   - valid bearer + use-case server_error  → 500
 *   - kill-switch off                       → 200 + { skipped: true, reason: 'feature_disabled' }
 *
 * Per-audience reclaim behaviour is covered by the use-case unit tests
 * (`tests/unit/broadcasts/application/reclaim-orphaned-audiences.test.ts`).
 * This test only locks the route shell: auth + kill-switch + status codes +
 * JSON response shape.
 *
 * Mirrors `cleanup-audiences-route.test.ts` mock structure exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const reclaimOrphanedAudiencesMock = vi.fn();

const envMock = {
  features: { f7Broadcasts: true },
  flags: { readOnlyMode: false },
  cron: { secret: 'test-cron-secret' },
  tenant: { slug: 'test-tenant' },
};

vi.mock('@/lib/env', () => ({
  env: envMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant' }),
}));
vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug }),
}));
vi.mock('@/modules/broadcasts', async () => ({
  reclaimOrphanedAudiences: (...args: unknown[]) =>
    reclaimOrphanedAudiencesMock(...args),
  makeReclaimOrphanedAudiencesDeps: () => ({}),
  // Spec 140 DT5 — the real margin, so the deadline case pins the route's rule.
  RECLAIM_DEADLINE_MARGIN_MS: (
    await vi.importActual<typeof import('@/modules/broadcasts/application/use-cases/reclaim-orphaned-audiences')>(
      '@/modules/broadcasts/application/use-cases/reclaim-orphaned-audiences',
    )
  ).RECLAIM_DEADLINE_MARGIN_MS,
}));

function makeRequest(opts: { auth?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) {
    headers['authorization'] = opts.auth;
  }
  return new NextRequest(
    'http://localhost/api/cron/broadcasts/reclaim-orphan-audiences',
    { method: 'POST', headers },
  );
}

beforeEach(() => {
  envMock.features.f7Broadcasts = true;
  envMock.flags.readOnlyMode = false;
  reclaimOrphanedAudiencesMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cron reclaim-orphan-audiences — wire contract', () => {
  it('missing Authorization → 401 unauthorized', async () => {
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reclaim-orphan-audiences/route'
    );
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthorized');
    expect(reclaimOrphanedAudiencesMock).not.toHaveBeenCalled();
  });

  it('wrong Bearer token → 401 unauthorized', async () => {
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reclaim-orphan-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthorized');
    expect(reclaimOrphanedAudiencesMock).not.toHaveBeenCalled();
  });

  it('valid bearer + no orphans → 200 + zeroed summary', async () => {
    reclaimOrphanedAudiencesMock.mockResolvedValueOnce(
      ok({ scanned: 0, orphaned: 0, deleted: 0, failed: 0, skippedLastAudience: 0, skippedNonMatching: 0 }),
    );
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reclaim-orphan-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.scanned).toBe(0);
    expect(body.orphaned).toBe(0);
    expect(body.deleted).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.skippedLastAudience).toBe(0);
    expect(body.skippedNonMatching).toBe(0);
    expect(reclaimOrphanedAudiencesMock).toHaveBeenCalledTimes(1);
  });

  it('valid bearer + some orphans deleted → 200 + aggregated summary', async () => {
    reclaimOrphanedAudiencesMock.mockResolvedValueOnce(
      ok({ scanned: 10, orphaned: 3, deleted: 2, failed: 1, skippedLastAudience: 0, skippedNonMatching: 4 }),
    );
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reclaim-orphan-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.scanned).toBe(10);
    expect(body.orphaned).toBe(3);
    expect(body.deleted).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.skippedLastAudience).toBe(0);
    expect(body.skippedNonMatching).toBe(4);
  });

  // Spec 140 DT5 — the run has a budget: the route's own maxDuration, and one
  // deadline inside it that covers the listing and the deletes. No request
  // field can move it.
  it('GET and POST are the same handler; a function budget of 300 s', async () => {
    const route = await import('@/app/api/cron/broadcasts/reclaim-orphan-audiences/route');
    expect(route.GET).toBe(route.POST);
    expect(route.maxDuration).toBe(300);
  });

  it('passes the use case a deadline of start + maxDuration − the margin', async () => {
    reclaimOrphanedAudiencesMock.mockResolvedValueOnce(
      ok({ scanned: 0, orphaned: 0, deleted: 0, failed: 0, skippedLastAudience: 0, skippedNonMatching: 0, truncated: false, deferredDeletes: 0 }),
    );
    const { POST } = await import('@/app/api/cron/broadcasts/reclaim-orphan-audiences/route');
    const { RECLAIM_DEADLINE_MARGIN_MS } = await import(
      '@/modules/broadcasts/application/use-cases/reclaim-orphaned-audiences'
    );
    const before = Date.now();
    await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    const input = reclaimOrphanedAudiencesMock.mock.calls[0]![1] as { deadlineAt?: Date };
    expect(input.deadlineAt).toBeInstanceOf(Date);
    const expected = before + 300_000 - RECLAIM_DEADLINE_MARGIN_MS;
    expect(input.deadlineAt!.getTime()).toBeGreaterThanOrEqual(expected);
    expect(input.deadlineAt!.getTime() - expected).toBeLessThan(5_000);
  });

  it('a run cut by its budget answers 200 and reports truncated + deferredDeletes in the body and the log', async () => {
    reclaimOrphanedAudiencesMock.mockResolvedValueOnce(
      ok({ scanned: 120, orphaned: 9, deleted: 5, failed: 0, skippedLastAudience: 0, skippedNonMatching: 3, truncated: true, deferredDeletes: 4 }),
    );
    const { POST } = await import('@/app/api/cron/broadcasts/reclaim-orphan-audiences/route');
    const { logger } = await import('@/lib/logger');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: 5, truncated: true, deferredDeletes: 4 });
    const tick = vi
      .mocked(logger.info)
      .mock.calls.filter((c) => c[1] === 'cron.broadcasts.reclaim_orphan_audiences.tick_complete')
      .at(-1);
    expect(tick?.[0]).toMatchObject({ truncated: true, deferredDeletes: 4 });
  });

  it('valid bearer + use-case returns server_error → 500', async () => {
    reclaimOrphanedAudiencesMock.mockResolvedValueOnce(
      err({ kind: 'reclaim.server_error', message: 'listAudiences failed' }),
    );
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reclaim-orphan-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('internal_error');
  });

  it('kill-switch off → 200 + {skipped:true, reason:feature_disabled}', async () => {
    envMock.features.f7Broadcasts = false;
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reclaim-orphan-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('feature_disabled');
    expect(reclaimOrphanedAudiencesMock).not.toHaveBeenCalled();
  });

  it('#408 READ_ONLY_MODE on → 200 skipped; no Resend audience listed or deleted', async () => {
    envMock.flags.readOnlyMode = true;
    const { POST } = await import(
      '@/app/api/cron/broadcasts/reclaim-orphan-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true, reason: 'read_only_mode' });
    expect(reclaimOrphanedAudiencesMock).not.toHaveBeenCalled();
  });
});
