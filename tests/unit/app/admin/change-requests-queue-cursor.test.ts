/**
 * F114 US4 (T074) — `/admin/change-requests` cursor handling.
 *
 * The page's docblock states the rule: "a malformed cursor is a 404, never
 * page one silently" — the keyset cursor is the ONE search param whose zod
 * rule is not lenient, because silently restarting at page one while the URL
 * says otherwise makes a reviewer believe they have seen the whole queue.
 *
 * PR-3 review (reliability R-L3): `one()` maps an EMPTY value to `undefined`
 * before the schema sees it, so `?cursor=` (a hand-edited URL, a form that
 * submitted an empty hidden input, a truncated share link) took the lenient
 * path the rule exists to forbid. An empty cursor is a malformed cursor.
 *
 * Only the page function is invoked (no render): what is under test is the
 * parse → `notFound()` / `listChangeRequestQueue({ cursor })` decision.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listQueue: vi.fn(),
  findById: vi.fn(),
}));

class NotFoundSignal extends Error {}

vi.mock('@/lib/env', () => ({
  env: { features: { memberChangeApproval: true }, tenant: { timezone: 'Asia/Bangkok' } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal('NEXT_NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  usePathname: () => '/admin/change-requests',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/rbac', () => ({ requirePagePermission: vi.fn(async () => ({ user: { id: 'u1', role: 'admin' } })) }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromHeaders: () => ({ slug: 'tenant-a' }) }));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => 'req-1' }));
vi.mock('@/lib/members-change-request-deps', () => ({
  buildChangeRequestDeps: () => ({ tenant: { slug: 'tenant-a' }, memberRepo: { findById: h.findById } }),
  asMembersUserId: (id: string) => id,
}));
vi.mock('@/modules/members', () => ({
  CHANGE_REQUEST_STATES: ['pending', 'decided', 'withdrawn'] as const,
  CHANGE_REQUEST_OUTCOMES: ['approved', 'partially_approved', 'rejected'] as const,
  asMemberId: (id: string) => id,
  listChangeRequestQueue: h.listQueue,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => Object.assign((key: string) => `${ns}.${key}`, { rich: (key: string) => key }),
  getLocale: async () => 'en',
}));

import ChangeRequestsQueuePage from '@/app/(staff)/admin/change-requests/page';

const EMPTY_PAGE = {
  items: [],
  nextCursor: null,
  pendingCount: 0,
  oldestPendingAgeSeconds: null,
};

const open = (searchParams: Record<string, string | string[] | undefined>) =>
  ChangeRequestsQueuePage({ searchParams: Promise.resolve(searchParams) });

beforeEach(() => {
  h.listQueue.mockReset().mockResolvedValue({ ok: true, value: EMPTY_PAGE });
  h.findById.mockReset();
});

describe('/admin/change-requests — the cursor is the one param that is NOT lenient', () => {
  it('no cursor → the default view, read with cursor null', async () => {
    await expect(open({})).resolves.toBeTruthy();
    expect(h.listQueue).toHaveBeenCalledTimes(1);
    expect(h.listQueue.mock.calls[0]![1]).toMatchObject({ cursor: null });
  });

  it('an EMPTY cursor (?cursor=) is malformed → notFound(), never page one (R-L3)', async () => {
    await expect(open({ cursor: '' })).rejects.toBeInstanceOf(NotFoundSignal);
    expect(h.listQueue).not.toHaveBeenCalled();
  });

  it('an empty cursor repeated in the query (?cursor=&cursor=) is the same refusal', async () => {
    await expect(open({ cursor: ['', 'abc'] })).rejects.toBeInstanceOf(NotFoundSignal);
    expect(h.listQueue).not.toHaveBeenCalled();
  });

  it('an over-long cursor is still refused by the schema', async () => {
    await expect(open({ cursor: 'x'.repeat(201) })).rejects.toBeInstanceOf(NotFoundSignal);
    expect(h.listQueue).not.toHaveBeenCalled();
  });

  it('a well-formed cursor is passed straight through — the refusal is not a blanket 404', async () => {
    await expect(open({ cursor: 'eyJhIjoxfQ' })).resolves.toBeTruthy();
    expect(h.listQueue.mock.calls[0]![1]).toMatchObject({ cursor: 'eyJhIjoxfQ' });
  });

  it('an EMPTY value on a LENIENT filter still drops only itself (state=) — the leniency split is intact', async () => {
    await expect(open({ state: '', outcome: '' })).resolves.toBeTruthy();
    expect(h.listQueue.mock.calls[0]![1]).toMatchObject({ cursor: null, filter: { state: 'pending' } });
  });
});
