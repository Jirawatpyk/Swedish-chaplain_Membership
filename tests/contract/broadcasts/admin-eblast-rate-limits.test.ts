// @vitest-environment node
// (multipart: `Request.formData()` hangs under jsdom — the File/FormData globals are
//  jsdom's while the body parser is undici's; the routes run on Node anyway.)
/**
 * F119 T026a (owner) · T062a (PR-2 extends) — the new write buckets on the
 * staff formatting routes and the member inline-image upload
 * (contracts/admin-eblast-formatting-api.md § Rate limits; spec § Roles).
 *
 *   staff  30 requests / 60 s per (tenant, actor):
 *     PATCH /api/admin/broadcasts/brand                 (T026)
 *     POST  /api/admin/broadcasts/[id]/images           (T106)
 *     POST  /api/admin/broadcasts/templates/[id]/images (T107)
 *     POST  /api/admin/broadcasts/[id]/version          (T062a)
 *     PATCH /api/admin/broadcasts/[id]/version          (T062a)
 *     POST  /api/admin/broadcasts/[id]/version/send     (T062a)
 *     POST  /api/admin/broadcasts/[id]/schedule         (T062a)
 *   member 60 / minute per (tenant, user):
 *     POST  /api/broadcasts/inline-image-upload         (T146 wires it)
 *
 * All over the existing `broadcastsRateLimiter.checkLimit`, in the
 * `RECIPIENT_COUNT_RATE_MAX` / `_WINDOW_SECONDS` shape — an ATOMIC check
 * (the limiter consumes on check; the route never peeks then acts), refused
 * 429 `broadcast_rate_limit_exceeded` with `Retry-After` and
 * `retryAfterSeconds`, consumed BEFORE the write so the refused call stores
 * nothing. `approve` / `reject` / `cancel` carry no bucket today, so every
 * number here is an addition, not a reuse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';
import {
  STAFF_WRITE_RATE_MAX,
  STAFF_WRITE_RATE_WINDOW_SECONDS,
  MEMBER_WRITE_RATE_MAX,
  MEMBER_WRITE_RATE_WINDOW_SECONDS,
  staffWriteRateKey,
  memberWriteRateKey,
} from '@/lib/broadcasts-write-rate-limit';

const requireApiPermissionMock = vi.fn();
const setBrandSettingsMock = vi.fn();
const getBrandSettingsMock = vi.fn();
const checkLimitMock = vi.fn();

vi.mock('@/lib/rbac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rbac')>('@/lib/rbac');
  return {
    canPerform: actual.canPerform,
    requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn('tx'),
}));
vi.mock('@/modules/broadcasts', () => ({
  setBrandSettings: (...args: unknown[]) => setBrandSettingsMock(...args),
  getBrandSettings: (...args: unknown[]) => getBrandSettingsMock(...args),
  broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
}));
vi.mock('@/lib/broadcast-brand-deps', () => ({
  makeBrandSettingsDeps: () => ({ repo: {}, audit: {}, logoUrl: {} }),
}));

const adminCtx = {
  current: {
    user: { id: 'user-admin-1', email: 'admin@swecham.test', role: 'admin' as const, status: 'active' as const, displayName: 'Admin' },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.10',
  requestId: 'req-rl-1',
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  requireApiPermissionMock.mockResolvedValue(adminCtx);
  setBrandSettingsMock.mockResolvedValue(ok({ primaryColor: '#b04a00', postalAddress: null, updatedAt: null, updatedByUserId: 'u' }));
  getBrandSettingsMock.mockResolvedValue({ primaryColor: '#b04a00', postalAddress: null, addressMissing: true, logo: { url: null, source: 'invoice_settings', manageHref: null }, defaults: { primaryColor: '#10487a' }, updatedAt: null });
});
afterEach(() => vi.clearAllMocks());

describe('the bucket constants (contract § Rate limits)', () => {
  it('staff 30 / 60 s per (tenant, actor); member 60 / 60 s per (tenant, user); keys are disjoint from the count bucket', () => {
    expect(STAFF_WRITE_RATE_MAX).toBe(30);
    expect(STAFF_WRITE_RATE_WINDOW_SECONDS).toBe(60);
    expect(MEMBER_WRITE_RATE_MAX).toBe(60);
    expect(MEMBER_WRITE_RATE_WINDOW_SECONDS).toBe(60);
    expect(staffWriteRateKey('t', 'u')).toBe('broadcasts:staff-write:t:u');
    expect(memberWriteRateKey('t', 'u')).toBe('broadcasts:member-write:t:u');
    expect(staffWriteRateKey('t', 'u')).not.toBe(memberWriteRateKey('t', 'u'));
  });
});

describe('PATCH /api/admin/broadcasts/brand — staff write bucket', () => {
  const patch = (body: unknown) =>
    new NextRequest('http://localhost/api/admin/broadcasts/brand', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('consumes the (tenant, actor) staff bucket with the contract numbers, BEFORE the write', async () => {
    checkLimitMock.mockResolvedValue(ok(true));
    const { PATCH } = await import('@/app/api/admin/broadcasts/brand/route');
    await PATCH(patch({ primaryColor: '#b04a00' }));
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:staff-write:test-tenant:user-admin-1', 30, 60);
    expect(checkLimitMock.mock.invocationCallOrder[0]!).toBeLessThan(setBrandSettingsMock.mock.invocationCallOrder[0]!);
  });

  it('the 31st brand PATCH in a minute → 429 broadcast_rate_limit_exceeded with Retry-After, and nothing is saved', async () => {
    checkLimitMock.mockResolvedValue(err({ retryAfterSeconds: 17 }));
    const { PATCH } = await import('@/app/api/admin/broadcasts/brand/route');
    const res = await PATCH(patch({ primaryColor: '#b04a00' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('17');
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_rate_limit_exceeded');
    expect(body.error.details).toEqual({ retryAfterSeconds: 17 });
    expect(setBrandSettingsMock).not.toHaveBeenCalled();
  });

  it('GET is not bucketed (reads are not writes)', async () => {
    checkLimitMock.mockResolvedValue(err({ retryAfterSeconds: 17 }));
    const { GET } = await import('@/app/api/admin/broadcasts/brand/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/broadcasts/brand'));
    expect(res.status).toBe(200);
    expect(checkLimitMock).not.toHaveBeenCalled();
  });
});

// --- T026a image arms — the three upload routes share `src/lib/broadcasts-image-upload-route.ts`.
// Their gates / use cases are mocked on a second barrel shape below (this
// file mocks `@/modules/broadcasts` once at the top; the upload routes read
// different exports, provided here without redeclaring the mock).
describe('image uploads — write buckets (T026a)', () => {
  const requireMemberContextMock = vi.fn();
  const authorizeMock = vi.fn();
  const uploadMock = vi.fn();
  const UUID = '11111111-1111-1111-1111-111111111111';
  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' });

  beforeEach(async () => {
    vi.doMock('@/lib/member-context', () => ({
      requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
    }));
    vi.doMock('@/lib/db', () => ({
      runInTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn('tx'),
    }));
    vi.doMock('@/modules/broadcasts', () => ({
      authorizeImageOwner: (...args: unknown[]) => authorizeMock(...args),
      uploadInlineImage: (...args: unknown[]) => uploadMock(...args),
      makeAuthorizeImageOwnerDeps: () => ({}),
      makeUploadInlineImageDeps: () => ({}),
      broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
      isF71aUs2Enabled: () => true,
      f71aUs2DisabledReason: () => null,
      parseBroadcastId: (id: string) => ({ ok: id === UUID, value: id, error: { kind: 'invalid_uuid' } }),
    }));
    requireMemberContextMock.mockResolvedValue({
      current: { user: { id: 'user-member-1', email: 'm@swecham.test', role: 'member', status: 'active', displayName: 'M' }, session: { id: 's' } },
      tenant: { slug: 'test-tenant', __brand: true },
      member: { memberId: 'm-1', planId: 'p' },
      memberId: 'm-1',
      ownContact: { contactId: 'c-1' },
      ownContactId: 'c-1',
      sourceIp: '203.0.113.10',
      requestId: 'req',
    });
    authorizeMock.mockResolvedValue(ok({ relatedMemberId: 'm-1' }));
    uploadMock.mockResolvedValue(ok({ blobUrl: 'u', allowlistedHostname: 'h', contentHash: 'c', imageId: 'i' }));
  });

  it('the 31st staff image upload in a minute → 429, and nothing is stored on the refused call (no ownership read, no scan)', async () => {
    checkLimitMock.mockResolvedValue(err({ retryAfterSeconds: 9 }));
    const { POST } = await import('@/app/api/admin/broadcasts/[id]/images/route');
    const form = new FormData();
    form.set('file', png());
    const res = await POST(new NextRequest(`http://localhost/api/admin/broadcasts/${UUID}/images`, { method: 'POST', body: form }), { params: Promise.resolve({ id: UUID }) });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('9');
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:staff-write:test-tenant:user-admin-1', 30, 60);
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('the 31st template image upload in a minute → 429 on the same staff bucket', async () => {
    checkLimitMock.mockResolvedValue(err({ retryAfterSeconds: 9 }));
    const { POST } = await import('@/app/api/admin/broadcasts/templates/[id]/images/route');
    const form = new FormData();
    form.set('file', png());
    const res = await POST(new NextRequest(`http://localhost/api/admin/broadcasts/templates/${UUID}/images`, { method: 'POST', body: form }), { params: Promise.resolve({ id: UUID }) });
    expect(res.status).toBe(429);
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:staff-write:test-tenant:user-admin-1', 30, 60);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('the 61st POST /api/broadcasts/inline-image-upload in a minute → 429 broadcast_rate_limit_exceeded with Retry-After — no blob, no row, no scan', async () => {
    checkLimitMock.mockResolvedValue(err({ retryAfterSeconds: 31 }));
    const { POST } = await import('@/app/api/broadcasts/inline-image-upload/route');
    const form = new FormData();
    form.set('file', png());
    form.set('draftId', UUID);
    const res = await POST(new NextRequest('http://localhost/api/broadcasts/inline-image-upload', { method: 'POST', body: form }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('31');
    expect((await res.json()).error.code).toBe('broadcast_rate_limit_exceeded');
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:member-write:test-tenant:user-member-1', 60, 60);
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('under the bucket the member upload proceeds (bucket first, then ownership, then the upload)', async () => {
    checkLimitMock.mockResolvedValue(ok(true));
    const { POST } = await import('@/app/api/broadcasts/inline-image-upload/route');
    const form = new FormData();
    form.set('file', png());
    form.set('draftId', UUID);
    const res = await POST(new NextRequest('http://localhost/api/broadcasts/inline-image-upload', { method: 'POST', body: form }));
    expect(res.status).toBe(201);
    expect(checkLimitMock.mock.invocationCallOrder[0]!).toBeLessThan(authorizeMock.mock.invocationCallOrder[0]!);
    expect(authorizeMock.mock.invocationCallOrder[0]!).toBeLessThan(uploadMock.mock.invocationCallOrder[0]!);
  });
});

// --- T062a — the formatting routes (`…/[id]/version` POST + PATCH).
describe('POST | PATCH /api/admin/broadcasts/[id]/version — staff write bucket (T062a)', () => {
  const startMock = vi.fn();
  const saveMock = vi.fn();
  const UUID = '11111111-1111-4111-8111-111111111111';
  const versionUrl = `http://localhost/api/admin/broadcasts/${UUID}/version`;
  const patchBody = {
    subject: 'S',
    bodyHtml: '<p>b</p>',
    bodySource: '{}',
    noteToMember: null,
    expectedUpdatedAt: '2026-09-24T08:30:00.000Z',
  };
  const patchReq = () =>
    new NextRequest(versionUrl, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patchBody) });
  const params = () => ({ params: Promise.resolve({ id: UUID }) });

  beforeEach(() => {
    vi.doMock('@/lib/broadcast-approval-deps', () => ({
      makeStartFormattedVersionDeps: () => ({}),
      makeSaveFormattedVersionDeps: () => ({}),
      makeListBroadcastVersionsDeps: () => ({}),
    }));
    vi.doMock('@/modules/broadcasts', () => ({
      startFormattedVersion: (...args: unknown[]) => startMock(...args),
      saveFormattedVersion: (...args: unknown[]) => saveMock(...args),
      listBroadcastVersions: vi.fn(),
      broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
      parseBroadcastId: (id: string) => ({ ok: id === UUID, value: id, error: { kind: 'invalid_uuid' } }),
      stageOf: () => 'in_design',
    }));
    startMock.mockReset();
    saveMock.mockReset();
    saveMock.mockResolvedValue(ok({ version: { id: 'v', versionNo: 1, updatedAt: new Date('2026-09-24T09:00:00.000Z') } }));
  });

  it('the 31st PATCH …/version in a minute → 429 broadcast_rate_limit_exceeded with Retry-After, and nothing is saved', async () => {
    checkLimitMock.mockResolvedValue(err({ retryAfterSeconds: 23 }));
    const { PATCH } = await import('@/app/api/admin/broadcasts/[id]/version/route');
    const res = await PATCH(patchReq(), params());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('23');
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_rate_limit_exceeded');
    expect(body.error.details).toEqual({ retryAfterSeconds: 23 });
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:staff-write:test-tenant:user-admin-1', 30, 60);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('POST …/version rides the same bucket: refused 429 before the use case runs; under the bucket the bucket is consumed first', async () => {
    const { POST } = await import('@/app/api/admin/broadcasts/[id]/version/route');
    checkLimitMock.mockResolvedValueOnce(err({ retryAfterSeconds: 5 }));
    const refused = await POST(new NextRequest(versionUrl, { method: 'POST' }), params());
    expect(refused.status).toBe(429);
    expect(startMock).not.toHaveBeenCalled();

    checkLimitMock.mockResolvedValueOnce(ok(true));
    startMock.mockResolvedValueOnce(err({ kind: 'round_zero' }));
    await POST(new NextRequest(versionUrl, { method: 'POST' }), params());
    expect(checkLimitMock).toHaveBeenLastCalledWith('broadcasts:staff-write:test-tenant:user-admin-1', 30, 60);
    expect(checkLimitMock.mock.invocationCallOrder.at(-1)!).toBeLessThan(startMock.mock.invocationCallOrder[0]!);
  });

  /**
   * T166 S-INFO — the PATCH body is up to 2 MB (`bodySource`), and parsing it
   * cost the server that much work BEFORE the bucket was consumed, so an
   * over-limit caller could keep making the route parse 2 MB for free. The
   * bucket is consumed FIRST now, as reject already does: a malformed
   * body still answers 400, but it spends one of the 30.
   */
  it('T166 S-INFO: the bucket is consumed BEFORE the PATCH body is parsed — an exhausted bucket answers 429 without reading the body', async () => {
    checkLimitMock.mockResolvedValue(err({ retryAfterSeconds: 17 }));
    const { PATCH } = await import('@/app/api/admin/broadcasts/[id]/version/route');
    const res = await PATCH(
      new NextRequest(versionUrl, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"subject":1}' }),
      params(),
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('broadcast_rate_limit_exceeded');
  });

  it('T166 S-INFO: under the bucket, a malformed PATCH body is still 400 — and it spent one call', async () => {
    checkLimitMock.mockResolvedValue(ok(true));
    const { PATCH } = await import('@/app/api/admin/broadcasts/[id]/version/route');
    const res = await PATCH(
      new NextRequest(versionUrl, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"subject":1}' }),
      params(),
    );
    expect(res.status).toBe(400);
    expect(checkLimitMock).toHaveBeenCalledTimes(1);
  });
});

// --- T062a — the send and schedule routes (T059 / T060).
describe('POST …/[id]/version/send and POST …/[id]/schedule — staff write bucket (T062a)', () => {
  const sendMock = vi.fn();
  const scheduleMock = vi.fn();
  const UUID = '11111111-1111-4111-8111-111111111111';
  const params = () => ({ params: Promise.resolve({ id: UUID }) });

  beforeEach(() => {
    vi.doMock('@/lib/broadcast-approval-deps', () => ({
      makeSendVersionToMemberDeps: () => ({}),
      makeConfirmScheduleDeps: () => ({}),
    }));
    vi.doMock('@/modules/broadcasts', () => ({
      sendVersionToMember: (...args: unknown[]) => sendMock(...args),
      confirmSchedule: (...args: unknown[]) => scheduleMock(...args),
      broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
      parseBroadcastId: (id: string) => ({ ok: id === UUID, value: id, error: { kind: 'invalid_uuid' } }),
      stageOf: () => 'in_design',
    }));
    sendMock.mockReset();
    scheduleMock.mockReset();
  });

  it('the 31st …/version/send in a minute → 429 with Retry-After, with no version sent and no outbox row (the use case never runs)', async () => {
    checkLimitMock.mockResolvedValue(err({ retryAfterSeconds: 17 }));
    const { POST } = await import('@/app/api/admin/broadcasts/[id]/version/send/route');
    const res = await POST(new NextRequest(`http://localhost/api/admin/broadcasts/${UUID}/version/send`, { method: 'POST' }), params());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('17');
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_rate_limit_exceeded');
    expect(body.error.details).toEqual({ retryAfterSeconds: 17 });
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:staff-write:test-tenant:user-admin-1', 30, 60);
    // `sendVersionToMember` is the only writer of the send stamp and the outbox row.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('…/schedule rides the same bucket: refused 429 before the use case; under the bucket the bucket is consumed first', async () => {
    const { POST } = await import('@/app/api/admin/broadcasts/[id]/schedule/route');
    const req = () =>
      new NextRequest(`http://localhost/api/admin/broadcasts/${UUID}/schedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'send_now' }),
      });
    checkLimitMock.mockResolvedValueOnce(err({ retryAfterSeconds: 4 }));
    const refused = await POST(req(), params());
    expect(refused.status).toBe(429);
    expect(scheduleMock).not.toHaveBeenCalled();

    checkLimitMock.mockResolvedValueOnce(ok(true));
    scheduleMock.mockResolvedValueOnce(err({ kind: 'no_proposal' }));
    await POST(req(), params());
    expect(checkLimitMock).toHaveBeenLastCalledWith('broadcasts:staff-write:test-tenant:user-admin-1', 30, 60);
    expect(checkLimitMock.mock.invocationCallOrder.at(-1)!).toBeLessThan(scheduleMock.mock.invocationCallOrder[0]!);
  });
});
