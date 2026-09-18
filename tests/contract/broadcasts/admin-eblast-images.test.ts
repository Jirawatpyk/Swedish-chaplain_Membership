// @vitest-environment node
// (multipart: `Request.formData()` hangs under jsdom — the File/FormData globals are
//  jsdom's while the body parser is undici's; the routes run on Node anyway.)
/**
 * F119 T096 (owner) · T106 · T106a (PR-2 extends) —
 * `POST /api/admin/broadcasts/[id]/images` (US3-AS3 compose-on-behalf half,
 * FR-040).
 *
 * Wire contract, use cases mocked at the barrel (`authorizeImageOwner` and
 * `uploadInlineImage` have their own unit / contract suites):
 *   - `broadcasts.write` named on the gate; the F7.1a US2 kill-switch → 503;
 *   - upload on a staff-owned `draft` → 201 with the row's `imageId`;
 *     on a `submitted` broadcast → 201 (the proxy author may still
 *     illustrate it);
 *   - on a closed one → 409; on another tenant's → 404 (+ the probe audit,
 *     emitted inside the use case);
 *   - an infected file → 422 with nothing stored (the upload use case
 *     refuses before any write; mapped here);
 *   - the upload runs as a STAFF actor carrying the owning member as
 *     `relatedMemberId` (never `memberId`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { err, ok } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const authorizeMock = vi.fn();
const uploadMock = vi.fn();
const checkLimitMock = vi.fn();
const flagMock = vi.fn(() => true);

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }),
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
  isF71aUs2Enabled: () => flagMock(),
  f71aUs2DisabledReason: () => 'f71a_us2_off',
  parseBroadcastId: (id: string) => (UUID_RE.test(id) ? { ok: true, value: id } : { ok: false, error: { kind: 'invalid_uuid' } }),
}));

const BID = '11111111-1111-1111-1111-111111111111';
const staffCtx = {
  current: {
    user: { id: 'user-mk-1', email: 'mk@swecham.test', role: 'marketing' as const, status: 'active' as const, displayName: 'Mk' },
    session: { id: 'sess-1' },
  },
  requestId: 'req-img-1',
};
const OK_UPLOAD = ok({ blobUrl: 'https://assets.swecham.zyncdata.app/broadcasts/images/test-tenant/abc.png', allowlistedHostname: 'assets.swecham.zyncdata.app', contentHash: 'abc', imageId: 'img-1' });

function req(id = BID, file: File | null = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' })): NextRequest {
  const form = new FormData();
  if (file) form.set('file', file);
  return new NextRequest(`http://localhost/api/admin/broadcasts/${id}/images`, { method: 'POST', body: form });
}
const params = (id = BID) => ({ params: Promise.resolve({ id }) });
const importRoute = () => import('@/app/api/admin/broadcasts/[id]/images/route');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  flagMock.mockReturnValue(true);
  requireApiPermissionMock.mockResolvedValue(staffCtx);
  checkLimitMock.mockResolvedValue(ok(true));
  authorizeMock.mockResolvedValue(ok({ relatedMemberId: '22222222-2222-2222-2222-222222222222' }));
  uploadMock.mockResolvedValue(OK_UPLOAD);
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/admin/broadcasts/[id]/images', () => {
  it('names broadcasts.write and returns the gate\'s 403 untouched', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({ response: NextResponse.json({ error: 'permission_denied' }, { status: 403 }) });
    const { POST } = await importRoute();
    expect((await POST(req(), params())).status).toBe(403);
    expect(requireApiPermissionMock.mock.calls[0]![1]).toBe('broadcasts.write');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('the F7.1a US2 kill-switch → 503 feature_disabled', async () => {
    flagMock.mockReturnValue(false);
    const { POST } = await importRoute();
    const res = await POST(req(), params());
    expect(res.status).toBe(503);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it('upload on a staff-owned draft → 201; the row and the audit are written by the use case as a STAFF actor with related_member_id', async () => {
    const { POST } = await importRoute();
    const res = await POST(req(), params());
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ imageId: 'img-1', contentHash: 'abc' });
    const [, authInput] = authorizeMock.mock.calls[0]!;
    expect(authInput).toMatchObject({ owner: { kind: 'broadcast', id: BID }, actor: { kind: 'staff' }, actorUserId: 'user-mk-1' });
    const [, upInput] = uploadMock.mock.calls[0]!;
    expect(upInput).toMatchObject({
      owner: { kind: 'broadcast', id: BID },
      actor: { role: 'marketing', relatedMemberId: '22222222-2222-2222-2222-222222222222' },
      mimeType: 'image/png',
      filename: 'a.png',
    });
    expect(upInput).not.toHaveProperty('actor.memberId');
  });

  it('on a submitted broadcast → 201 (the proxy author may still illustrate it — the stage set is the use case\'s)', async () => {
    const { POST } = await importRoute();
    expect((await POST(req(), params())).status).toBe(201);
  });

  it('on a closed one → 409 with the status; nothing is uploaded', async () => {
    authorizeMock.mockResolvedValueOnce(err({ kind: 'closed', status: 'sent' }));
    const { POST } = await importRoute();
    const res = await POST(req(), params());
    expect(res.status).toBe(409);
    expect((await res.json()).error.details).toEqual({ status: 'sent' });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('on another tenant\'s → 404 (the probe audit is the use case\'s); a malformed id → 404 before any lookup', async () => {
    authorizeMock.mockResolvedValueOnce(err({ kind: 'not_found' }));
    const { POST } = await importRoute();
    expect((await POST(req(), params())).status).toBe(404);
    expect((await POST(req('not-a-uuid'), params('not-a-uuid'))).status).toBe(404);
    expect(authorizeMock).toHaveBeenCalledTimes(1);
  });

  it('an infected file → 422 with nothing stored; oversize → 413; wrong MIME → 415; blob down → 503', async () => {
    const { POST } = await importRoute();
    uploadMock.mockResolvedValueOnce(err({ kind: 'broadcast_image_unsafe', reason: 'EICAR' }));
    expect((await POST(req(), params())).status).toBe(422);
    uploadMock.mockResolvedValueOnce(err({ kind: 'broadcast_image_too_large', sizeBytes: 6_000_000 }));
    expect((await POST(req(), params())).status).toBe(413);
    uploadMock.mockResolvedValueOnce(err({ kind: 'broadcast_image_invalid_mime', receivedMime: 'text/html' }));
    expect((await POST(req(), params())).status).toBe(415);
    uploadMock.mockResolvedValueOnce(err({ kind: 'storage_unavailable', reason: 'x' }));
    expect((await POST(req(), params())).status).toBe(503);
  });

  it('a form without a file → 400 invalid_body before the bucket is consumed', async () => {
    const { POST } = await importRoute();
    expect((await POST(req(BID, null), params())).status).toBe(400);
    expect(checkLimitMock).not.toHaveBeenCalled();
  });
});
