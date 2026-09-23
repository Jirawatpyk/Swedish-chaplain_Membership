// @vitest-environment node
// (multipart: `Request.formData()` hangs under jsdom — the File/FormData globals are
//  jsdom's while the body parser is undici's; the routes run on Node anyway.)
/**
 * F119 T107 — `POST /api/admin/broadcasts/templates/[id]/images` (FR-046a).
 *
 * Part 1 (wire, use cases mocked at the barrel): `broadcasts.write`; a
 * template image is recorded under `owner_kind='template'` with
 * `related_member_id: null`; a missing template → 404; 201 on success.
 *
 * Part 2 (behaviour, real use cases over the port fakes): deleting the
 * template leaves a draft started from it working — the draft holds its OWN
 * `broadcast_images` row sharing the content hash (images travel by
 * reference), so when the template's rows are marked the last-reference
 * sweep keeps the blob.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberId } from '@/modules/members';
import { NextRequest, NextResponse } from 'next/server';
import { err, ok } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const authorizeMock = vi.fn();
const uploadMock = vi.fn();
const checkLimitMock = vi.fn();

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
vi.mock('@/modules/broadcasts', async () => {
  const actual = await vi.importActual<typeof import('@/modules/broadcasts/application/use-cases/upload-inline-image')>(
    '@/modules/broadcasts/application/use-cases/upload-inline-image',
  );
  return {
    __actualUpload: actual.uploadInlineImage,
    authorizeImageOwner: (...args: unknown[]) => authorizeMock(...args),
    uploadInlineImage: (...args: unknown[]) => uploadMock(...args),
    makeAuthorizeImageOwnerDeps: () => ({}),
    makeUploadInlineImageDeps: () => ({}),
    broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
    isF71aUs2Enabled: () => true,
    f71aUs2DisabledReason: () => null,
  };
});

const TID = '11111111-1111-1111-1111-111111111111';
const staffCtx = {
  current: {
    user: { id: 'user-admin-1', email: 'admin@swecham.test', role: 'admin' as const, status: 'active' as const, displayName: 'Admin' },
    session: { id: 'sess-1' },
  },
  requestId: 'req-tpl-1',
};

function req(id = TID): NextRequest {
  const form = new FormData();
  form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'b.png', { type: 'image/png' }));
  return new NextRequest(`http://localhost/api/admin/broadcasts/templates/${id}/images`, { method: 'POST', body: form });
}
const params = (id = TID) => ({ params: Promise.resolve({ id }) });
const importRoute = () => import('@/app/api/admin/broadcasts/templates/[id]/images/route');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  requireApiPermissionMock.mockResolvedValue(staffCtx);
  checkLimitMock.mockResolvedValue(ok(true));
  authorizeMock.mockResolvedValue(ok({ relatedMemberId: null }));
  uploadMock.mockResolvedValue(ok({ blobUrl: 'https://assets.swecham.zyncdata.app/x.png', allowlistedHostname: 'assets.swecham.zyncdata.app', contentHash: 'abc', imageId: 'img-t1' }));
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/admin/broadcasts/templates/[id]/images — wire', () => {
  it('names broadcasts.write; a template image is recorded under owner_kind=template with related_member_id null', async () => {
    const { POST } = await importRoute();
    const res = await POST(req(), params());
    expect(res.status).toBe(201);
    expect(requireApiPermissionMock.mock.calls[0]![1]).toBe('broadcasts.write');
    const [, authInput] = authorizeMock.mock.calls[0]!;
    expect(authInput).toMatchObject({ owner: { kind: 'template', id: TID }, actor: { kind: 'staff' } });
    const [, upInput] = uploadMock.mock.calls[0]!;
    expect(upInput).toMatchObject({ owner: { kind: 'template', id: TID }, actor: { role: 'admin', relatedMemberId: null } });
  });

  it('a missing template → 404; the gate\'s 403 is returned untouched; a non-uuid id → 404 before any lookup', async () => {
    const { POST } = await importRoute();
    authorizeMock.mockResolvedValueOnce(err({ kind: 'not_found' }));
    expect((await POST(req(), params())).status).toBe(404);
    expect((await POST(req('nope'), params('nope'))).status).toBe(404);
    expect(authorizeMock).toHaveBeenCalledTimes(1);
    requireApiPermissionMock.mockResolvedValueOnce({ response: NextResponse.json({ error: 'permission_denied' }, { status: 403 }) });
    expect((await POST(req(), params())).status).toBe(403);
  });
});

describe('template images travel by reference (FR-046a) — real use cases over the fakes', () => {
  it('deleting the template (marking its rows) leaves a draft started from it working: the blob survives the sweep', async () => {
    const { makeFakeBroadcastImagesRepo, makeFakeImageStorage, makeFakeImageReencoder, FAKE_TX } = await import('../../helpers/eblast-approval-fakes');
    const { __actualUpload } = (await import('@/modules/broadcasts')) as unknown as {
      __actualUpload: typeof import('@/modules/broadcasts/application/use-cases/upload-inline-image').uploadInlineImage;
    };
    const { reclaimOrphanedImages } = await import('@/modules/broadcasts/application/use-cases/reclaim-orphaned-images');
    const imagesRepo = makeFakeBroadcastImagesRepo();
    const storage = makeFakeImageStorage();
    const audit = { emit: vi.fn(async () => undefined), emitTyped: vi.fn(async () => undefined) };
    const deps = {
      allowlistPort: {
        withTx: async <T,>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(null),
        findByTenantId: async () => [],
        seedDefaults: async () => undefined,
        add: async () => ok(undefined),
        remove: async () => ok(undefined),
      },
      scanner: { scan: async () => ({ verdict: 'clean' as const, durationMs: 1 }) },
      storage,
      audit,
      imagesRepo,
      reencoder: makeFakeImageReencoder(),
    };
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32, 7)]);
    const base = { tenantId: 'test-tenant' as never, actorUserId: 'u', actorEmail: 'u@x', requestId: 'r', fileBytes: bytes, filename: 'b.png', mimeType: 'image/png' };
    const tpl = await __actualUpload(deps, { ...base, owner: { kind: 'template', id: TID }, actor: { role: 'admin', relatedMemberId: null } });
    expect(tpl.ok).toBe(true);
    // The member starts a draft from the template: same bytes, its own row.
    const draft = await __actualUpload(deps, { ...base, owner: { kind: 'broadcast', id: '22222222-2222-2222-2222-222222222222' }, actor: { role: 'member', memberId: 'm-1' as MemberId } });
    expect(draft.ok).toBe(true);
    expect(imagesRepo.rows).toHaveLength(2);
    expect(storage.keys.size).toBe(1);

    // The template is deleted: its image rows are marked; the draft's row is live.
    await imagesRepo.markDeletedByOwner('test-tenant' as never, { kind: 'template', id: TID }, new Date(), FAKE_TX);
    const sweep = await reclaimOrphanedImages({ imagesRepo, storage, audit }, { tenantId: 'test-tenant' as never, now: new Date(), requestId: 'c' });
    expect(sweep).toEqual({ ok: true, value: { scanned: 1, blobsDeleted: 0, rowsRemoved: 1, retained: 0, rowsFailed: 0 } });
    expect(storage.deleted).toEqual([]);
    expect(imagesRepo.rows.map((r) => r.ownerKind)).toEqual(['broadcast']);
  });
});
