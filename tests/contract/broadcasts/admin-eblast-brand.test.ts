/**
 * F119 T012 / T024 / T025 / T026 — `GET | PATCH /api/admin/broadcasts/brand`
 * (contracts/admin-eblast-formatting-api.md § brand; FR-041b/c).
 *
 * Wire contract, use cases mocked at the barrel (their behaviour is pinned
 * in tests/unit/broadcasts/application/{set,get}-brand-settings.test.ts):
 *   - `requireApiPermission(request, 'settings.broadcasts')` on BOTH verbs —
 *     the real evaluator refuses `marketing` and `manager` for that key;
 *   - GET 200 carries the read-only logo with `manageHref` only for a
 *     `settings.invoicing` holder (super_admin);
 *   - PATCH: 422 `colour_contrast` with `{ ratio, required }`; 422
 *     `validation_error` on a malformed colour / an over-long address; 400
 *     `invalid_body` on an empty patch; **no logo key is accepted** — a body
 *     carrying one is refused, so no write path to the invoice logo exists;
 *   - PATCH passes the SESSION role and never a literal (audit-truth);
 *   - the write bucket (30 / 60 s per tenant+actor) is T026a's file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { err, ok } from '@/lib/result';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';

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

const ctxFor = (role: 'admin' | 'super_admin') => ({
  current: {
    user: { id: `user-${role}`, email: `${role}@swecham.test`, role, status: 'active' as const, displayName: role },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.10',
  requestId: 'req-brand-1',
});
const denied = NextResponse.json({ error: 'permission_denied' }, { status: 403 });

function getRequest(): NextRequest {
  return new NextRequest('http://localhost/api/admin/broadcasts/brand', { method: 'GET' });
}
function patchRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/broadcasts/brand', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const importRoute = () => import('@/app/api/admin/broadcasts/brand/route');

const GET_VIEW = {
  primaryColor: '#b04a00',
  postalAddress: '1 Street',
  addressMissing: false,
  logo: { url: 'https://blob.example/l.png', source: 'invoice_settings', manageHref: null },
  defaults: { primaryColor: '#10487a' },
  updatedAt: null,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  checkLimitMock.mockResolvedValue(ok(true));
  getBrandSettingsMock.mockResolvedValue(GET_VIEW);
  setBrandSettingsMock.mockResolvedValue(ok({ primaryColor: '#b04a00', postalAddress: '1 Street', updatedAt: new Date('2026-09-18T00:00:00Z'), updatedByUserId: 'user-admin' }));
});
afterEach(() => vi.clearAllMocks());

describe('permission key (the evaluator, not the mock, decides who holds it)', () => {
  it('`marketing` and `manager` do not hold settings.broadcasts; admin and super_admin do', () => {
    expect(hasPermission('marketing', 'settings.broadcasts')).toBe(false);
    expect(hasPermission('manager', 'settings.broadcasts')).toBe(false);
    expect(hasPermission('admin', 'settings.broadcasts')).toBe(true);
    expect(hasPermission('super_admin', 'settings.broadcasts')).toBe(true);
    // The logo stays super-admin only (FR-041b).
    expect(hasPermission('admin', 'settings.invoicing')).toBe(false);
    expect(hasPermission('super_admin', 'settings.invoicing')).toBe(true);
  });

  it('GET and PATCH both name settings.broadcasts and return the gate\'s 403 untouched (marketing → 403 permission_denied, audited by the gate)', async () => {
    requireApiPermissionMock.mockResolvedValue({ response: denied });
    const { GET, PATCH } = await importRoute();
    expect((await GET(getRequest())).status).toBe(403);
    expect((await PATCH(patchRequest({ primaryColor: '#b04a00' }))).status).toBe(403);
    expect(requireApiPermissionMock).toHaveBeenCalledTimes(2);
    for (const call of requireApiPermissionMock.mock.calls) expect(call[1]).toBe('settings.broadcasts');
    expect(getBrandSettingsMock).not.toHaveBeenCalled();
    expect(setBrandSettingsMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/broadcasts/brand', () => {
  it('200: the view, with `manageHref` computed from the SESSION role — null for an admin', async () => {
    requireApiPermissionMock.mockResolvedValue(ctxFor('admin'));
    const { GET } = await importRoute();
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GET_VIEW);
    const [, input] = getBrandSettingsMock.mock.calls[0]!;
    expect(input).toEqual({ tenantId: 'test-tenant', canManageInvoiceSettings: false });
  });

  it('a super_admin (settings.invoicing holder) is passed canManageInvoiceSettings: true', async () => {
    requireApiPermissionMock.mockResolvedValue(ctxFor('super_admin'));
    const { GET } = await importRoute();
    await GET(getRequest());
    const [, input] = getBrandSettingsMock.mock.calls[0]!;
    expect(input).toEqual({ tenantId: 'test-tenant', canManageInvoiceSettings: true });
  });
});

describe('PATCH /api/admin/broadcasts/brand', () => {
  it('200: saves and returns the view; the use case receives the session role, never a literal', async () => {
    requireApiPermissionMock.mockResolvedValue(ctxFor('super_admin'));
    const { PATCH } = await importRoute();
    const res = await PATCH(patchRequest({ primaryColor: '#b04a00', postalAddress: '1 Street' }));
    expect(res.status).toBe(200);
    const [, input] = setBrandSettingsMock.mock.calls[0]!;
    expect(input).toMatchObject({
      tenantId: 'test-tenant',
      actorUserId: 'user-super_admin',
      actorRole: 'super_admin',
      primaryColor: '#b04a00',
      postalAddress: '1 Street',
    });
    expect(await res.json()).toEqual(GET_VIEW);
  });

  it('422 colour_contrast carries { ratio, required } and the stored colour is unchanged (the use case refused before any write)', async () => {
    requireApiPermissionMock.mockResolvedValue(ctxFor('admin'));
    setBrandSettingsMock.mockResolvedValueOnce(err({ kind: 'colour_contrast', ratio: 1.08, required: 4.5 }));
    const { PATCH } = await importRoute();
    const res = await PATCH(patchRequest({ primaryColor: '#f5f5f5' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('colour_contrast');
    expect(body.error.details).toEqual({ ratio: 1.08, required: 4.5 });
    expect(getBrandSettingsMock).not.toHaveBeenCalled();
  });

  it('422 validation_error on a malformed colour and on a 301-character address', async () => {
    requireApiPermissionMock.mockResolvedValue(ctxFor('admin'));
    const { PATCH } = await importRoute();
    setBrandSettingsMock.mockResolvedValueOnce(err({ kind: 'invalid_color_format' }));
    expect((await PATCH(patchRequest({ primaryColor: 'red' }))).status).toBe(422);
    setBrandSettingsMock.mockResolvedValueOnce(err({ kind: 'address_too_long', max: 300 }));
    const res = await PATCH(patchRequest({ postalAddress: 'x'.repeat(301) }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('validation_error');
  });

  it('400 invalid_body on an empty patch, a non-object and malformed JSON', async () => {
    requireApiPermissionMock.mockResolvedValue(ctxFor('admin'));
    const { PATCH } = await importRoute();
    expect((await PATCH(patchRequest({}))).status).toBe(400);
    expect((await PATCH(patchRequest([]))).status).toBe(400);
    expect((await PATCH(patchRequest('{not json'))).status).toBe(400);
    expect(setBrandSettingsMock).not.toHaveBeenCalled();
  });

  it('accepts NO logo key: a body naming the logo is refused 400 and nothing is saved (FR-041b)', async () => {
    requireApiPermissionMock.mockResolvedValue(ctxFor('super_admin'));
    const { PATCH } = await importRoute();
    for (const body of [
      { logoBlobKey: 'invoicing/x/logos/evil.png' },
      { logo: { url: 'https://evil.example/l.png' } },
      { primaryColor: '#b04a00', logoBlobKey: 'invoicing/x/logos/evil.png' },
    ]) {
      const res = await PATCH(patchRequest(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(setBrandSettingsMock).not.toHaveBeenCalled();
  });

  it('500 storage_error maps to 500 with a correlation id and no body detail', async () => {
    requireApiPermissionMock.mockResolvedValue(ctxFor('admin'));
    setBrandSettingsMock.mockResolvedValueOnce(err({ kind: 'storage_error', detail: 'boom' }));
    const { PATCH } = await importRoute();
    const res = await PATCH(patchRequest({ primaryColor: '#b04a00' }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('boom');
  });
});
