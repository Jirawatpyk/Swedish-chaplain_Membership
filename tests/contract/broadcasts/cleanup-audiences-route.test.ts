/**
 * Contract test: POST /api/cron/broadcasts/cleanup-audiences.
 *
 * Wire-contract surfaces:
 *   - missing Authorization header       → 401 unauthorized
 *   - wrong Bearer token                 → 401 unauthorized
 *   - valid bearer + no candidates       → 200 + { processed:0, deleted:0, failed:0 }
 *   - valid bearer + use-case ok result  → 200 + aggregated { processed, deleted, failed }
 *   - valid bearer + use-case server_error → 500
 *
 * Per-candidate cleanup behavior is covered by the use-case unit tests
 * (`tests/unit/broadcasts/application/cleanup-orphaned-audiences.test.ts`).
 * This test only locks the route shell auth + tick-level status code +
 * JSON summary shape.
 *
 * Mirrors `cron-reconcile-stuck-sending.contract.test.ts` mock structure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const cleanupOrphanedAudiencesMock = vi.fn();

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
vi.mock('@/modules/broadcasts', () => ({
  // Spec 140 s2c review round 1 — the route's grace is the use case's constant.
  AUDIENCE_CLEANUP_GRACE_MS: 60 * 60 * 1000,
  cleanupOrphanedAudiences: (...args: unknown[]) =>
    cleanupOrphanedAudiencesMock(...args),
  makeCleanupOrphanedAudiencesDeps: () => ({}),
}));

function makeRequest(opts: { auth?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) {
    headers['authorization'] = opts.auth;
  }
  return new NextRequest(
    'http://localhost/api/cron/broadcasts/cleanup-audiences',
    { method: 'POST', headers },
  );
}

beforeEach(() => {
  envMock.features.f7Broadcasts = true;
  envMock.flags.readOnlyMode = false;
  cleanupOrphanedAudiencesMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cron cleanup-audiences — wire contract', () => {
  it('missing Authorization → 401 unauthorized', async () => {
    const { POST } = await import(
      '@/app/api/cron/broadcasts/cleanup-audiences/route'
    );
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthorized');
    expect(cleanupOrphanedAudiencesMock).not.toHaveBeenCalled();
  });

  it('wrong Bearer token → 401 unauthorized', async () => {
    const { POST } = await import(
      '@/app/api/cron/broadcasts/cleanup-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthorized');
    expect(cleanupOrphanedAudiencesMock).not.toHaveBeenCalled();
  });

  it('valid bearer + no candidates → 200 + zeroed summary', async () => {
    cleanupOrphanedAudiencesMock.mockResolvedValueOnce(
      ok({ processed: 0, deleted: 0, failed: 0 }),
    );
    const { POST } = await import(
      '@/app/api/cron/broadcasts/cleanup-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.processed).toBe(0);
    expect(body.deleted).toBe(0);
    expect(body.failed).toBe(0);
    expect(cleanupOrphanedAudiencesMock).toHaveBeenCalledTimes(1);
  });

  it('valid bearer + some deleted and failed → 200 + aggregated summary', async () => {
    cleanupOrphanedAudiencesMock.mockResolvedValueOnce(
      ok({ processed: 5, deleted: 3, failed: 2 }),
    );
    const { POST } = await import(
      '@/app/api/cron/broadcasts/cleanup-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.processed).toBe(5);
    expect(body.deleted).toBe(3);
    expect(body.failed).toBe(2);
  });

  // Spec 140 s2d (#736a, pdpa M-3) — the drain's erasedReadFailed reaches
  // the tick_complete line and the body, beside listFailed.
  it('the orphan drain counts, erasedReadFailed included, reach tick_complete and the body', async () => {
    const orphans = { listed: 3, settled: 2, undecided: 0, waiting: 1, deferred: 0, listFailed: false, erasedReadFailed: true };
    cleanupOrphanedAudiencesMock.mockResolvedValueOnce(ok({ processed: 0, deleted: 0, failed: 0, orphans }));
    const { POST } = await import(
      '@/app/api/cron/broadcasts/cleanup-audiences/route'
    );
    const { logger } = await import('@/lib/logger');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { orphans?: unknown }).orphans).toEqual(orphans);
    const line = vi.mocked(logger.info).mock.calls.find((c) => c[1] === 'cron.broadcasts.cleanup_audiences.tick_complete');
    expect((line?.[0] as { orphans?: unknown } | undefined)?.orphans).toEqual(orphans);
  });

  it('valid bearer + use-case returns server_error → 500', async () => {
    cleanupOrphanedAudiencesMock.mockResolvedValueOnce(
      err({ kind: 'cleanup.server_error', message: 'neon outage' }),
    );
    const { POST } = await import(
      '@/app/api/cron/broadcasts/cleanup-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('internal_error');
  });

  it('kill-switch off → 200 + {skipped:true, reason:feature_disabled}', async () => {
    envMock.features.f7Broadcasts = false;
    const { POST } = await import(
      '@/app/api/cron/broadcasts/cleanup-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('feature_disabled');
    expect(cleanupOrphanedAudiencesMock).not.toHaveBeenCalled();
  });

  it('#408 READ_ONLY_MODE on → 200 skipped; no Resend audience deleted', async () => {
    envMock.flags.readOnlyMode = true;
    const { POST } = await import(
      '@/app/api/cron/broadcasts/cleanup-audiences/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true, reason: 'read_only_mode' });
    expect(cleanupOrphanedAudiencesMock).not.toHaveBeenCalled();
  });
});
