// @vitest-environment node
// (multipart: `Request.formData()` hangs under jsdom — the File/FormData globals are
//  jsdom's while the body parser is undici's; the routes run on Node anyway.)
/**
 * F119 T138 / T146 — `POST /api/broadcasts/inline-image-upload` gains the
 * REAL draft-ownership check (US6-AS7, FR-040): before F119 `draftId` was an
 * unvalidated form string although the route's header claimed a check.
 *
 * Wire contract, use cases mocked at the barrel (the ownership decisions and
 * their probe audits are pinned in
 * `tests/unit/broadcasts/application/authorize-image-owner.test.ts`):
 *   - another member's draft → 404 (+ `broadcast_cross_member_probe`, in the
 *     use case); an unknown / other-tenant id → 404 (+ `broadcast_cross_tenant_probe`);
 *     a closed broadcast → 409; never 403;
 *   - the upload runs as the MEMBER actor (`memberId`, so the audit carries
 *     snake_case `member_id` and `last_activity_at` moves) for the caller's
 *     own draft;
 *   - the 60 / minute member bucket (T026a) is consumed ABOVE the ownership
 *     read, the blob write and the ClamAV call: the refused call reaches no
 *     use case at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { err, ok } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const authorizeMock = vi.fn();
const uploadMock = vi.fn();
const checkLimitMock = vi.fn();

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn('tx'),
}));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
vi.mock('@/modules/broadcasts', () => ({
  authorizeImageOwner: (...args: unknown[]) => authorizeMock(...args),
  uploadInlineImage: (...args: unknown[]) => uploadMock(...args),
  makeAuthorizeImageOwnerDeps: () => ({}),
  makeUploadInlineImageDeps: () => ({}),
  broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
  isF71aUs2Enabled: () => true,
  f71aUs2DisabledReason: () => null,
  parseBroadcastId: (id: string) => (UUID_RE.test(id) ? { ok: true, value: id } : { ok: false, error: { kind: 'invalid_uuid' } }),
}));

const DRAFT = '11111111-1111-1111-1111-111111111111';
const memberCtx = {
  current: {
    user: { id: 'user-member-1', email: 'member@swecham.test', role: 'member' as const, status: 'active' as const, displayName: 'Member' },
    session: { id: 'sess-m-1' },
  },
  tenant: { slug: 'test-tenant', __brand: true },
  member: { memberId: 'm-1', planId: 'p-prem' },
  memberId: 'm-1',
  ownContact: { contactId: 'c-1' },
  ownContactId: 'c-1',
  sourceIp: '203.0.113.10',
  requestId: 'req-own-1',
};

function req(draftId: string | null = DRAFT): NextRequest {
  const form = new FormData();
  form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' }));
  if (draftId !== null) form.set('draftId', draftId);
  return new NextRequest('http://localhost/api/broadcasts/inline-image-upload', { method: 'POST', body: form });
}
const importRoute = () => import('@/app/api/broadcasts/inline-image-upload/route');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  requireMemberContextMock.mockResolvedValue(memberCtx);
  checkLimitMock.mockResolvedValue(ok(true));
  authorizeMock.mockResolvedValue(ok({ relatedMemberId: 'm-1' }));
  uploadMock.mockResolvedValue(ok({ blobUrl: 'https://assets.swecham.zyncdata.app/x.png', allowlistedHostname: 'assets.swecham.zyncdata.app', contentHash: 'abc', imageId: 'img-1' }));
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/broadcasts/inline-image-upload — ownership (T146)', () => {
  it('the caller\'s own draft → 201, uploaded as the MEMBER actor (member_id, not related_member_id)', async () => {
    const { POST } = await importRoute();
    const res = await POST(req());
    expect(res.status).toBe(201);
    const [, authInput] = authorizeMock.mock.calls[0]!;
    expect(authInput).toMatchObject({ owner: { kind: 'broadcast', id: DRAFT }, actor: { kind: 'member', memberId: 'm-1' }, actorUserId: 'user-member-1' });
    const [, upInput] = uploadMock.mock.calls[0]!;
    expect(upInput).toMatchObject({ owner: { kind: 'broadcast', id: DRAFT }, actor: { role: 'member', memberId: 'm-1' } });
  });

  it('another member\'s draft → 404 (the cross-member probe is audited by the use case), never 403', async () => {
    authorizeMock.mockResolvedValueOnce(err({ kind: 'not_found' }));
    const { POST } = await importRoute();
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('an unknown or other-tenant id → 404; a malformed draftId → 400 before any lookup', async () => {
    authorizeMock.mockResolvedValueOnce(err({ kind: 'not_found' }));
    const { POST } = await importRoute();
    expect((await POST(req())).status).toBe(404);
    expect((await POST(req('not-a-uuid'))).status).toBe(400);
    expect((await POST(req(null))).status).toBe(400);
    expect(authorizeMock).toHaveBeenCalledTimes(1);
  });

  it('a closed broadcast → 409', async () => {
    authorizeMock.mockResolvedValueOnce(err({ kind: 'closed', status: 'submitted' }));
    const { POST } = await importRoute();
    expect((await POST(req())).status).toBe(409);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('the member gate\'s response is returned untouched', async () => {
    requireMemberContextMock.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no_session' }, { status: 401 }) });
    const { POST } = await importRoute();
    expect((await POST(req())).status).toBe(401);
    expect(checkLimitMock).not.toHaveBeenCalled();
  });
});
