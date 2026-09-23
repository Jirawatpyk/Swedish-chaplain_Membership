// @vitest-environment node
// (two of the three routes take multipart bodies — see admin-eblast-images.test.ts)
/**
 * F119 T046a — the PR-1 staff role matrix on the three staff routes PR-1
 * ships (contracts/admin-eblast-formatting-api.md § permission map):
 *   POST /api/admin/broadcasts/[id]/images            broadcasts.write
 *   POST /api/admin/broadcasts/templates/[id]/images  broadcasts.write
 *   POST /api/admin/broadcasts/test-copy              broadcasts.write
 *
 * Two halves, both real: (1) the permission EVALUATOR decides who holds
 * `broadcasts.write` — `manager` (read-only) and `member` do not, `marketing`
 * does; (2) each route names exactly that key on its gate (the source is
 * read, and `pnpm check:api-route-guard` pins the same pairs against
 * `tests/helpers/rbac-observed-baseline.ts`), and returns the gate's refusal
 * untouched. A member session never reaches a staff route: `requireApiPermission`
 * refuses it before the key is even evaluated (a person who also holds a
 * portal account of the owning member gets the same refusal — the session
 * decides, spec § Roles).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok } from '@/lib/result';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';

const requireApiPermissionMock = vi.fn();
const checkLimitMock = vi.fn();
const authorizeMock = vi.fn();
const uploadMock = vi.fn();
const sendTestCopyMock = vi.fn();

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
vi.mock('@/lib/broadcast-test-copy-deps', () => ({
  makeSendTestCopyDeps: async () => ({ sanitizer: {}, brand: {}, renderer: {}, mailer: {}, audit: {}, tenantDisplayName: 'T' }),
}));
vi.mock('@/modules/broadcasts', () => ({
  authorizeImageOwner: (...args: unknown[]) => authorizeMock(...args),
  uploadInlineImage: (...args: unknown[]) => uploadMock(...args),
  sendTestCopy: (...args: unknown[]) => sendTestCopyMock(...args),
  makeAuthorizeImageOwnerDeps: () => ({}),
  makeUploadInlineImageDeps: () => ({}),
  broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
  isF71aUs2Enabled: () => true,
  f71aUs2DisabledReason: () => null,
  parseBroadcastId: (id: string) => ({ ok: /^[0-9a-f-]{36}$/.test(id), value: id, error: { kind: 'invalid_uuid' } }),
  TEST_COPY_SUBJECT_MAX: 200,
  TEST_COPY_BODY_MAX_BYTES: 200 * 1024,
}));

const ID = '11111111-1111-1111-1111-111111111111';
const ROOT = join(__dirname, '..', '..', '..');
const ROUTES = [
  { name: 'POST /api/admin/broadcasts/[id]/images', file: 'src/app/api/admin/broadcasts/[id]/images/route.ts', load: () => import('@/app/api/admin/broadcasts/[id]/images/route'), multipart: true, path: `/api/admin/broadcasts/${ID}/images` },
  { name: 'POST /api/admin/broadcasts/templates/[id]/images', file: 'src/app/api/admin/broadcasts/templates/[id]/images/route.ts', load: () => import('@/app/api/admin/broadcasts/templates/[id]/images/route'), multipart: true, path: `/api/admin/broadcasts/templates/${ID}/images` },
  { name: 'POST /api/admin/broadcasts/test-copy', file: 'src/app/api/admin/broadcasts/test-copy/route.ts', load: () => import('@/app/api/admin/broadcasts/test-copy/route'), multipart: false, path: '/api/admin/broadcasts/test-copy' },
] as const;

function request(route: (typeof ROUTES)[number]): NextRequest {
  if (route.multipart) {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' }));
    return new NextRequest(`http://localhost${route.path}`, { method: 'POST', body: form });
  }
  return new NextRequest(`http://localhost${route.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: 'S', bodyHtml: '<p>b</p>', locale: 'en' }),
  });
}
const ctxFor = (role: string) => ({
  current: { user: { id: `user-${role}`, email: `${role}@swecham.test`, role, status: 'active' as const, displayName: role }, session: { id: 's' } },
  requestId: 'req',
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  checkLimitMock.mockResolvedValue(ok(true));
  authorizeMock.mockResolvedValue(ok({ relatedMemberId: null }));
  uploadMock.mockResolvedValue(ok({ blobUrl: 'u', allowlistedHostname: 'h', contentHash: 'c', imageId: 'i' }));
  sendTestCopyMock.mockResolvedValue(ok({ messageId: 'm' }));
});
afterEach(() => vi.clearAllMocks());

describe('T046a — the evaluator decides broadcasts.write', () => {
  it('manager and member do not hold it; marketing, admin and super_admin do', () => {
    expect(hasPermission('manager', 'broadcasts.write')).toBe(false);
    expect(hasPermission('member', 'broadcasts.write')).toBe(false);
    expect(hasPermission('marketing', 'broadcasts.write')).toBe(true);
    expect(hasPermission('admin', 'broadcasts.write')).toBe(true);
    expect(hasPermission('super_admin', 'broadcasts.write')).toBe(true);
  });
});

for (const route of ROUTES) {
  describe(route.name, () => {
    it('names its permission key `broadcasts.write` on the gate (what check:api-route-guard pins)', () => {
      const src = readFileSync(join(ROOT, route.file), 'utf8');
      expect(src).toMatch(/requireApiPermission\(\s*request\s*,\s*'broadcasts\.write'\s*\)/);
    });

    it('`marketing` → 200-class (the gate admits, the route runs)', async () => {
      requireApiPermissionMock.mockResolvedValue(ctxFor('marketing'));
      const { POST } = await route.load();
      const res = await POST(request(route), { params: Promise.resolve({ id: ID }) });
      expect([201, 202]).toContain(res.status);
    });

    it('`manager` → 403 (a write route, read-only role): the gate\'s refusal is returned untouched and nothing runs', async () => {
      requireApiPermissionMock.mockResolvedValue({ response: NextResponse.json({ error: 'permission_denied' }, { status: 403 }) });
      const { POST } = await route.load();
      const res = await POST(request(route), { params: Promise.resolve({ id: ID }) });
      expect(res.status).toBe(403);
      expect(requireApiPermissionMock.mock.calls[0]![1]).toBe('broadcasts.write');
      expect(checkLimitMock).not.toHaveBeenCalled();
      expect(uploadMock).not.toHaveBeenCalled();
      expect(sendTestCopyMock).not.toHaveBeenCalled();
    });

    it('a member session → 403 (the staff gate refuses a portal session before any key is read)', async () => {
      requireApiPermissionMock.mockResolvedValue({ response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) });
      const { POST } = await route.load();
      const res = await POST(request(route), { params: Promise.resolve({ id: ID }) });
      expect(res.status).toBe(403);
      expect(uploadMock).not.toHaveBeenCalled();
      expect(sendTestCopyMock).not.toHaveBeenCalled();
    });
  });
}
