// @vitest-environment node
// (multipart: `Request.formData()` hangs under jsdom — the File/FormData globals are
//  jsdom's while the body parser is undici's; the routes run on Node anyway.)
/**
 * F119 security review F1-3 — the image-upload pipeline's two resource bugs.
 *
 * 1. `handleImageUpload` wrapped the WHOLE pipeline in
 *    `runInTenant(input.tenant, async () => {…})` whose `tx` it never used,
 *    while `authorizeImageOwner`'s repos and `imagesRepo.withTx` each open
 *    their OWN `runInTenant`. A second pool connection was therefore requested
 *    while the first sat idle-in-transaction across the ClamAV scan (up to
 *    50 s at the 5 MB cap) and the Blob PUT. The pool is `max: 10`
 *    (`src/lib/db.ts`), so ten concurrent uploads starved the whole site. The
 *    shared handler must open NO transaction of its own.
 *
 * 2. The member route read `draftId` from `await request.clone().formData()`
 *    BEFORE the shared handler's `content-length` 413 check, and the handler
 *    then parsed the form a SECOND time — so a 6 MB body was buffered and
 *    parsed twice before being refused. The owner id now rides a
 *    `readOwnerId(form)` callback: the guard runs first and the form is parsed
 *    exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const authorizeMock = vi.fn();
const uploadMock = vi.fn();
const checkLimitMock = vi.fn();
const runInTenantMock = vi.fn(
  async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn('tx'),
);

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: (...args: unknown[]) =>
    (runInTenantMock as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
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
  parseBroadcastId: (id: string) =>
    UUID_RE.test(id) ? { ok: true, value: id } : { ok: false, error: { kind: 'invalid_uuid' } },
}));

const DRAFT = '11111111-1111-1111-1111-111111111111';
const memberCtx = {
  current: {
    user: {
      id: 'user-member-1',
      email: 'member@swecham.test',
      role: 'member' as const,
      status: 'active' as const,
      displayName: 'Member',
    },
    session: { id: 'sess-m-1' },
  },
  tenant: { slug: 'test-tenant', __brand: true },
  member: { memberId: 'm-1', planId: 'p-prem' },
  memberId: 'm-1',
  ownContact: { contactId: 'c-1' },
  ownContactId: 'c-1',
  sourceIp: '203.0.113.10',
  requestId: 'req-pipeline-1',
};

interface SpiedRequest {
  readonly request: NextRequest;
  readonly formData: ReturnType<typeof vi.spyOn>;
  readonly clone: ReturnType<typeof vi.spyOn>;
}

function req(contentLength?: number): SpiedRequest {
  const form = new FormData();
  form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' }));
  form.set('draftId', DRAFT);
  const headers = new Headers();
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  const request = new NextRequest('http://localhost/api/broadcasts/inline-image-upload', {
    method: 'POST',
    body: form,
    headers,
  });
  return {
    request,
    formData: vi.spyOn(request, 'formData'),
    clone: vi.spyOn(request, 'clone'),
  };
}

const importRoute = () => import('@/app/api/broadcasts/inline-image-upload/route');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  requireMemberContextMock.mockResolvedValue(memberCtx);
  checkLimitMock.mockResolvedValue(ok(true));
  authorizeMock.mockResolvedValue(ok({ relatedMemberId: 'm-1' }));
  uploadMock.mockResolvedValue(
    ok({
      blobUrl: 'https://assets.swecham.zyncdata.app/x.png',
      allowlistedHostname: 'assets.swecham.zyncdata.app',
      contentHash: 'abc',
      imageId: 'img-1',
    }),
  );
  runInTenantMock.mockImplementation(async (_ctx, fn) => fn('tx'));
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/broadcasts/inline-image-upload — F1-3 pipeline resources', () => {
  it('a 6 MB content-length is refused 413 BEFORE the form is parsed', async () => {
    const spied = req(6 * 1024 * 1024);
    const { POST } = await importRoute();

    const res = await POST(spied.request);

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'broadcast_image_too_large' });
    // Neither the route nor the handler may buffer the body to reach this.
    expect(spied.clone).not.toHaveBeenCalled();
    expect(spied.formData).not.toHaveBeenCalled();
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(checkLimitMock).not.toHaveBeenCalled();
  });

  it('the form is parsed exactly ONCE on the happy path (no clone)', async () => {
    const spied = req();
    const { POST } = await importRoute();

    const res = await POST(spied.request);

    expect(res.status).toBe(201);
    expect(spied.formData).toHaveBeenCalledTimes(1);
    expect(spied.clone).not.toHaveBeenCalled();
    // The owner still reaches the use cases: the callback read it from the
    // one parsed form.
    expect(authorizeMock.mock.calls[0]?.[1]).toMatchObject({
      owner: { kind: 'broadcast', id: DRAFT },
    });
  });

  it('the shared handler opens NO transaction of its own (the pool-starvation fix)', async () => {
    const spied = req();
    const { POST } = await importRoute();

    const res = await POST(spied.request);

    expect(res.status).toBe(201);
    // `authorizeImageOwner` + `imagesRepo.withTx` are mocked here, so every
    // surviving call would be the route layer's own — and there must be none:
    // the outer scope held a connection idle-in-transaction across the ClamAV
    // scan and the Blob PUT while the inner paths asked the pool for a second.
    expect(runInTenantMock).not.toHaveBeenCalled();
  });

  it('a malformed draftId is still refused 400 before the ownership read', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0x89])], 'a.png', { type: 'image/png' }));
    form.set('draftId', 'not-a-uuid');
    const request = new NextRequest('http://localhost/api/broadcasts/inline-image-upload', {
      method: 'POST',
      body: form,
    });
    const { POST } = await importRoute();

    const res = await POST(request);

    expect(res.status).toBe(400);
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('a missing draftId is refused 400', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0x89])], 'a.png', { type: 'image/png' }));
    const request = new NextRequest('http://localhost/api/broadcasts/inline-image-upload', {
      method: 'POST',
      body: form,
    });
    const { POST } = await importRoute();

    const res = await POST(request);

    expect(res.status).toBe(400);
    expect(authorizeMock).not.toHaveBeenCalled();
  });
});

// `NextResponse` is imported so the route module's `NextResponse.json` shares
// this realm (the ownership suite does the same).
void NextResponse;
