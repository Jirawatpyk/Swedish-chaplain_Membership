/**
 * Contract test — `GET /api/admin/renewals/tier-upgrades` (#765).
 *
 * The queue now pages by a real keyset, so `?cursor=` is live: a cursor the
 * route can't decode (including the old row-id cursor) answers 400
 * `invalid_cursor` and never reaches the repo; a valid one is passed through,
 * and `next_cursor` comes back from the repo unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const requireRenewalAdminContextMock = vi.fn();
const listForAdminQueueMock = vi.fn();

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === 'features') return { ...target.features, f8Renewals: true };
        return Reflect.get(target, prop);
      },
    }),
  };
});
vi.mock('@/lib/renewals-route-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/renewals-route-helpers')>(
    '@/lib/renewals-route-helpers',
  );
  return {
    ...actual,
    requireRenewalAdminContext: (...args: unknown[]) => requireRenewalAdminContextMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>('@/modules/renewals');
  return {
    ...actual,
    makeRenewalsDeps: () => ({ tierUpgradeRepo: { listForAdminQueue: listForAdminQueueMock } }),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-list-1',
  correlationId: 'corr-list-1',
};

const ID = '0b5f6a8e-2d47-4c1a-9f3e-7a1b2c3d4e5f';

async function get(query: string) {
  const { GET } = await import('@/app/api/admin/renewals/tier-upgrades/route');
  return GET(new NextRequest(`http://localhost/api/admin/renewals/tier-upgrades${query}`));
}

describe('contract: GET /api/admin/renewals/tier-upgrades — cursor (#765)', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ['the old row-id cursor', `?cursor=${ID}`],
    ['garbage', '?cursor=%25%25%25'],
  ])('400 invalid_cursor for %s, and the repo is not called', async (_label, query) => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const res = await get(query);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_cursor');
    expect(listForAdminQueueMock).not.toHaveBeenCalled();
  });

  it('passes a valid cursor through and returns the next one', async () => {
    const { encodeTierQueueCursor } = await import('@/modules/renewals');
    const cursor = encodeTierQueueCursor({ createdAt: '2026-11-10T03:04:05.123456Z', suggestionId: ID });
    const next = encodeTierQueueCursor({ createdAt: '2026-11-09T01:00:00Z', suggestionId: ID });
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    listForAdminQueueMock.mockResolvedValueOnce({ items: [], nextCursor: next });
    const res = await get(`?cursor=${cursor}&limit=50`);
    expect(res.status).toBe(200);
    expect(listForAdminQueueMock).toHaveBeenCalledWith('test', { limit: 50, cursor });
    const body = (await res.json()) as { next_cursor: string | null };
    expect(body.next_cursor).toBe(next);
  });
});
