/**
 * 016 post-ship follow-up — provenance clamp on the portal SSR chokepoint.
 *
 * `enforcePortalPageAccess` read `x-pathname` raw. The proxy overwrites that
 * header server-side on every request it runs on and skips exactly the
 * requests carrying a prefetch marker — so only marked requests can carry a
 * client-forged path. A suspended/terminated member could prefetch a BLOCKED
 * portal page with `x-pathname` forged to an allowlisted path and receive
 * the blocked page's payload. On marked requests the path must become a
 * sentinel no allowlist can match (fail-closed for blocked-class members;
 * active members are allowed everywhere so they are unaffected).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
const headersMock = vi.fn();
const checkPortalAccess = vi.fn();
const findByLinkedUserId = vi.fn();

vi.mock('next/headers', () => ({ headers: () => headersMock() }));
vi.mock('next/navigation', () => ({ redirect: (u: string) => redirect(u) }));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromHeaders: () => ({ slug: 'test-tenant' }),
}));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => 'req-1' }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findByLinkedUserId: (...a: unknown[]) => findByLinkedUserId(...a) },
  }),
}));
vi.mock('@/lib/lapsed-portal-scope', () => ({
  checkPortalAccess: (...a: unknown[]) => checkPortalAccess(...a),
}));
vi.mock('@/lib/portal-access-deps', () => ({
  buildCachedPortalAccessDeps: () => ({}),
}));

import { enforcePortalPageAccess } from '@/lib/portal-page-access';
import type { CurrentSession } from '@/lib/auth-session';

const SESSION = { user: { id: 'u-1', role: 'member' } } as unknown as CurrentSession;

beforeEach(() => {
  vi.clearAllMocks();
  findByLinkedUserId.mockResolvedValue({ ok: true, value: { memberId: 'm-1' } });
});

describe('enforcePortalPageAccess — prefetch provenance clamp', () => {
  it('a prefetch-marked request with a FORGED allowed path is judged on the sentinel and still redirects', async () => {
    headersMock.mockResolvedValue(
      new Headers({ 'x-pathname': '/portal', 'next-router-prefetch': '1' }),
    );
    checkPortalAccess.mockResolvedValue({ allowed: false });
    await expect(enforcePortalPageAccess(SESSION)).rejects.toThrow('REDIRECT:/portal');
    expect(checkPortalAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pathname: 'prefetch:unattributed' }),
    );
  });

  it('purpose: prefetch (the second proxy-skip marker) clamps too', async () => {
    headersMock.mockResolvedValue(
      new Headers({ 'x-pathname': '/portal', purpose: 'prefetch' }),
    );
    checkPortalAccess.mockResolvedValue({ allowed: true });
    await enforcePortalPageAccess(SESSION);
    expect(checkPortalAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pathname: 'prefetch:unattributed' }),
    );
  });

  it('a normal request keeps the proxy-written path (query stripped)', async () => {
    headersMock.mockResolvedValue(
      new Headers({ 'x-pathname': '/portal/invoices?tab=open' }),
    );
    checkPortalAccess.mockResolvedValue({ allowed: true });
    await enforcePortalPageAccess(SESSION);
    expect(checkPortalAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pathname: '/portal/invoices' }),
    );
    expect(redirect).not.toHaveBeenCalled();
  });

  it('an allowed decision on a prefetch request does not redirect (active members unaffected)', async () => {
    headersMock.mockResolvedValue(
      new Headers({ 'x-pathname': '/portal/benefits', 'next-router-prefetch': '1' }),
    );
    checkPortalAccess.mockResolvedValue({ allowed: true });
    await enforcePortalPageAccess(SESSION);
    expect(redirect).not.toHaveBeenCalled();
  });
});
