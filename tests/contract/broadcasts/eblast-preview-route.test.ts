/**
 * F119 T032 — `POST /api/broadcasts/preview` (member, `requireMemberContext`)
 * and `POST /api/admin/broadcasts/preview` (staff, `broadcasts.read`)
 * (research R11; FR-043 — the preview is the real email).
 *
 * Both are thin wrappers over the SAME `renderBroadcastPreview` use case the
 * sender's wrapper feeds, returning a full HTML document for an
 * `<iframe srcdoc>`. Wire contract, use case mocked at the barrel:
 *   - 200 `{ html }`;
 *   - 400 `invalid_body` over the limits (subject > 200, body > 200 KB) and
 *     on a malformed body — decided by the ROUTE schema before the limiter
 *     is consumed, so an oversize body cannot burn a token;
 *   - 429 at 30 renders / minute per actor with `Retry-After` — the same
 *     `broadcasts:preview:<tenant>:<user>` key on both surfaces, consumed
 *     BEFORE the render (an amplification guard on a server-side render);
 *   - the member surface renders for the member; the staff surface renders
 *     for the staff user — `surface` is what the counter labels;
 *   - no audit event (a preview is not a state change).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { err, ok } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const requireApiPermissionMock = vi.fn();
const renderBroadcastPreviewMock = vi.fn();
const checkLimitMock = vi.fn();

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/broadcasts', () => ({
  renderBroadcastPreview: (...args: unknown[]) => renderBroadcastPreviewMock(...args),
  broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
  // The route schema reads the caps from the barrel — the same numbers the
  // use case enforces (200 / 200 KB), pinned here so the test cannot drift.
  PREVIEW_SUBJECT_MAX: 200,
  PREVIEW_BODY_MAX_BYTES: 200 * 1024,
}));
vi.mock('@/lib/broadcast-brand-deps', () => ({
  makeRenderBroadcastPreviewDeps: async () => ({ sanitizer: {}, brand: {}, renderer: {}, tenantDisplayName: 'Test Chamber' }),
}));

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
  requestId: 'req-preview-1',
};
const staffCtx = {
  current: {
    user: { id: 'user-marketing-1', email: 'mk@swecham.test', role: 'marketing' as const, status: 'active' as const, displayName: 'Mk' },
    session: { id: 'sess-s-1' },
  },
  requestId: 'req-preview-2',
};

const VALID = { subject: 'Hello', bodyHtml: '<p>Body</p>', locale: 'th' };

function req(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const importMember = () => import('@/app/api/broadcasts/preview/route');
const importStaff = () => import('@/app/api/admin/broadcasts/preview/route');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  checkLimitMock.mockResolvedValue(ok(true));
  renderBroadcastPreviewMock.mockResolvedValue(ok({ html: '<!doctype html><html lang="th"></html>' }));
  requireMemberContextMock.mockResolvedValue(memberCtx);
  requireApiPermissionMock.mockResolvedValue(staffCtx);
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/broadcasts/preview (member)', () => {
  it('200 { html }: renders through the shared use case for the member surface, in the requested locale', async () => {
    const { POST } = await importMember();
    const res = await POST(req('/api/broadcasts/preview', VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ html: '<!doctype html><html lang="th"></html>' });
    const [, input] = renderBroadcastPreviewMock.mock.calls[0]!;
    expect(input).toMatchObject({ tenantId: 'test-tenant', subject: 'Hello', bodyHtml: '<p>Body</p>', locale: 'th', surface: 'member', tenantDisplayName: 'Test Chamber' });
  });

  it('returns the member gate\'s response untouched (401 / 403 / 503 read-only)', async () => {
    requireMemberContextMock.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no_session' }, { status: 401 }) });
    const { POST } = await importMember();
    expect((await POST(req('/api/broadcasts/preview', VALID))).status).toBe(401);
    expect(renderBroadcastPreviewMock).not.toHaveBeenCalled();
  });

  it('a 201 KB body → 400 invalid_body before the limiter is consumed', async () => {
    const { POST } = await importMember();
    const res = await POST(req('/api/broadcasts/preview', { ...VALID, bodyHtml: '<p>' + 'x'.repeat(201 * 1024) + '</p>' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    expect(checkLimitMock).not.toHaveBeenCalled();
    expect(renderBroadcastPreviewMock).not.toHaveBeenCalled();
  });

  it('a 201-character subject, an unknown locale and malformed JSON → 400 invalid_body', async () => {
    const { POST } = await importMember();
    expect((await POST(req('/api/broadcasts/preview', { ...VALID, subject: 'x'.repeat(201) }))).status).toBe(400);
    expect((await POST(req('/api/broadcasts/preview', { ...VALID, locale: 'de' }))).status).toBe(400);
    expect((await POST(req('/api/broadcasts/preview', '{nope'))).status).toBe(400);
  });

  it('an empty subject is allowed (the compose preview renders before the subject is typed)', async () => {
    const { POST } = await importMember();
    expect((await POST(req('/api/broadcasts/preview', { ...VALID, subject: '' }))).status).toBe(200);
  });

  it('31st render in a minute → 429 with Retry-After, consumed BEFORE the render', async () => {
    checkLimitMock.mockResolvedValueOnce(err({ retryAfterSeconds: 23 }));
    const { POST } = await importMember();
    const res = await POST(req('/api/broadcasts/preview', VALID));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('23');
    expect((await res.json()).error.code).toBe('broadcast_rate_limit_exceeded');
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:preview:test-tenant:user-member-1', 30, 60);
    expect(renderBroadcastPreviewMock).not.toHaveBeenCalled();
  });

  it('a sanitiser fault → 500 internal_error with no detail in the body', async () => {
    renderBroadcastPreviewMock.mockResolvedValueOnce(err({ kind: 'sanitizer_unavailable', reason: 'jsdom exploded' }));
    const { POST } = await importMember();
    const res = await POST(req('/api/broadcasts/preview', VALID));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('jsdom');
  });
});

describe('POST /api/admin/broadcasts/preview (staff)', () => {
  it('names broadcasts.read (a manager may preview) and renders for the staff surface', async () => {
    const { POST } = await importStaff();
    const res = await POST(req('/api/admin/broadcasts/preview', VALID));
    expect(res.status).toBe(200);
    expect(requireApiPermissionMock.mock.calls[0]![1]).toBe('broadcasts.read');
    const [, input] = renderBroadcastPreviewMock.mock.calls[0]!;
    expect(input).toMatchObject({ surface: 'staff', tenantId: 'test-tenant' });
  });

  it('returns the gate\'s 403 untouched', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({ response: NextResponse.json({ error: 'permission_denied' }, { status: 403 }) });
    const { POST } = await importStaff();
    expect((await POST(req('/api/admin/broadcasts/preview', VALID))).status).toBe(403);
  });

  it('is limited per staff actor on the same 30 / minute preview bucket', async () => {
    checkLimitMock.mockResolvedValueOnce(err({ retryAfterSeconds: 5 }));
    const { POST } = await importStaff();
    const res = await POST(req('/api/admin/broadcasts/preview', VALID));
    expect(res.status).toBe(429);
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:preview:test-tenant:user-marketing-1', 30, 60);
  });
});
