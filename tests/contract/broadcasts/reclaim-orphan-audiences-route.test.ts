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
  reclaimOrphanedAudiences: (...args: unknown[]) =>
    reclaimOrphanedAudiencesMock(...args),
  makeReclaimOrphanedAudiencesDeps: () => ({}),
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
      ok({ scanned: 0, orphaned: 0, deleted: 0, failed: 0, skippedNonMatching: 0 }),
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
    expect(body.skippedNonMatching).toBe(0);
    expect(reclaimOrphanedAudiencesMock).toHaveBeenCalledTimes(1);
  });

  it('valid bearer + some orphans deleted → 200 + aggregated summary', async () => {
    reclaimOrphanedAudiencesMock.mockResolvedValueOnce(
      ok({ scanned: 10, orphaned: 3, deleted: 2, failed: 1, skippedNonMatching: 4 }),
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
    expect(body.skippedNonMatching).toBe(4);
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
});
