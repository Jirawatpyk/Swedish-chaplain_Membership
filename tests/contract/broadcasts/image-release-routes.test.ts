// @vitest-environment node
/**
 * Spec 131 — the three image RELEASE routes (layer 1):
 *   DELETE /api/broadcasts/inline-image-upload/[imageId]?draftId=…  (member)
 *   DELETE /api/admin/broadcasts/[id]/images/[imageId]               (staff)
 *   DELETE /api/admin/broadcasts/templates/[id]/images/[imageId]     (staff)
 *
 * Wire contract, use case mocked at the barrel (`releaseUnusedImage` has its
 * own unit suite): each route runs its upload route's gate, the F7.1a US2
 * kill-switch and the actor's write bucket, then maps the use case:
 * released → 200 `{ released }`, not_found → 404, closed → 409 (the member
 * route's shipped code, staff `stage_changed`). A malformed id → 404 before
 * any lookup. CSRF and the read-only freeze are the proxy's, for every
 * state-changing `/api/**` request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { err, ok } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const requireMemberContextMock = vi.fn();
const releaseMock = vi.fn();
const checkLimitMock = vi.fn();
const flagMock = vi.fn(() => true);

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
vi.mock('@/modules/broadcasts', () => ({
  releaseUnusedImage: (...args: unknown[]) => releaseMock(...args),
  makeReleaseUnusedImageDeps: () => ({}),
  broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
  isF71aUs2Enabled: () => flagMock(),
  f71aUs2DisabledReason: () => 'f71a_us2_off',
  parseBroadcastId: (id: string) => (UUID_RE.test(id) ? { ok: true, value: id } : { ok: false, error: { kind: 'invalid_uuid' } }),
}));

const BID = '11111111-1111-1111-1111-111111111111';
const TID = '44444444-4444-4444-4444-444444444444';
const IMG = '55555555-5555-5555-5555-555555555555';
const MEMBER = '22222222-2222-2222-2222-222222222222';
const staffCtx = {
  current: {
    user: { id: 'user-mk-1', email: 'mk@swecham.test', role: 'marketing' as const, status: 'active' as const, displayName: 'Mk' },
    session: { id: 'sess-1' },
  },
  requestId: 'req-1',
};
const memberCtx = {
  tenant: { slug: 'test-tenant' },
  member: { memberId: MEMBER },
  current: { user: { id: 'user-m-1', email: 'm@swecham.test', role: 'member' } },
};

const del = (url: string) => new NextRequest(`http://localhost${url}`, { method: 'DELETE' });
const memberRoute = () => import('@/app/api/broadcasts/inline-image-upload/[imageId]/route');
const staffRoute = () => import('@/app/api/admin/broadcasts/[id]/images/[imageId]/route');
const templateRoute = () => import('@/app/api/admin/broadcasts/templates/[id]/images/[imageId]/route');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  flagMock.mockReturnValue(true);
  requireApiPermissionMock.mockResolvedValue(staffCtx);
  requireMemberContextMock.mockResolvedValue(memberCtx);
  checkLimitMock.mockResolvedValue(ok(true));
  releaseMock.mockResolvedValue(ok({ released: true }));
});
afterEach(() => vi.clearAllMocks());

describe('DELETE /api/broadcasts/inline-image-upload/[imageId] (member)', () => {
  const call = async (imageId = IMG, query = `?draftId=${BID}`) => {
    const { DELETE } = await memberRoute();
    return DELETE(del(`/api/broadcasts/inline-image-upload/${imageId}${query}`), { params: Promise.resolve({ imageId }) });
  };

  it('releases the member\'s own image → 200 { released: true }, as a MEMBER actor on the draft', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: true });
    const [, input] = releaseMock.mock.calls[0]!;
    expect(input).toMatchObject({
      owner: { kind: 'broadcast', id: BID },
      imageId: IMG,
      actor: { kind: 'member', memberId: MEMBER },
      actorUserId: 'user-m-1',
      actorRole: 'member',
    });
  });

  it('a repeated release answers 200 { released: false }', async () => {
    releaseMock.mockResolvedValueOnce(ok({ released: false }));
    expect(await (await call()).json()).toEqual({ released: false });
  });

  it('a malformed image id → 404 and a missing draftId → 400, before any lookup', async () => {
    expect((await call('not-a-uuid')).status).toBe(404);
    expect((await call(IMG, '')).status).toBe(400);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("another member's draft → 404; a closed draft → 409 broadcast_invalid_state_transition", async () => {
    releaseMock.mockResolvedValueOnce(err({ kind: 'not_found' }));
    expect((await call()).status).toBe(404);
    releaseMock.mockResolvedValueOnce(err({ kind: 'closed', status: 'submitted' }));
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('broadcast_invalid_state_transition');
  });

  it('the write bucket refuses → 429 with Retry-After; the kill-switch → 503; neither touches the row', async () => {
    checkLimitMock.mockResolvedValueOnce(err({ retryAfterSeconds: 7 }));
    const limited = await call();
    expect(limited.status).toBe(429);
    flagMock.mockReturnValue(false);
    expect((await call()).status).toBe(503);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('an unauthenticated member gets the context guard\'s own response', async () => {
    requireMemberContextMock.mockResolvedValueOnce({ response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) });
    expect((await call()).status).toBe(401);
    expect(releaseMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/broadcasts/[id]/images/[imageId] (staff)', () => {
  const call = async (id = BID, imageId = IMG) => {
    const { DELETE } = await staffRoute();
    return DELETE(del(`/api/admin/broadcasts/${id}/images/${imageId}`), { params: Promise.resolve({ id, imageId }) });
  };

  it('names broadcasts.write and returns the gate\'s 403 untouched', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({ response: NextResponse.json({ error: 'permission_denied' }, { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect(requireApiPermissionMock.mock.calls[0]![1]).toBe('broadcasts.write');
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('releases as a STAFF actor carrying the session role → 200', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const [, input] = releaseMock.mock.calls[0]!;
    expect(input).toMatchObject({
      owner: { kind: 'broadcast', id: BID },
      imageId: IMG,
      actor: { kind: 'staff' },
      actorUserId: 'user-mk-1',
      actorRole: 'marketing',
    });
  });

  it('a closed E-Blast → 409 stage_changed; a malformed id → 404 before any lookup', async () => {
    releaseMock.mockResolvedValueOnce(err({ kind: 'closed', status: 'sent' }));
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('stage_changed');
    expect((await call('nope')).status).toBe(404);
    expect((await call(BID, 'nope')).status).toBe(404);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/admin/broadcasts/templates/[id]/images/[imageId] (staff, template)', () => {
  const call = async (id = TID, imageId = IMG) => {
    const { DELETE } = await templateRoute();
    return DELETE(del(`/api/admin/broadcasts/templates/${id}/images/${imageId}`), { params: Promise.resolve({ id, imageId }) });
  };

  it('releases the template\'s image → 200, owner_kind template', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(requireApiPermissionMock.mock.calls[0]![1]).toBe('broadcasts.write');
    const [, input] = releaseMock.mock.calls[0]!;
    expect(input).toMatchObject({ owner: { kind: 'template', id: TID }, imageId: IMG, actor: { kind: 'staff' } });
  });

  it('an unknown template → 404; a malformed id → 404 before any lookup', async () => {
    releaseMock.mockResolvedValueOnce(err({ kind: 'not_found' }));
    expect((await call()).status).toBe(404);
    expect((await call('nope')).status).toBe(404);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
