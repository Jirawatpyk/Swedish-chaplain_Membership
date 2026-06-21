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
});
