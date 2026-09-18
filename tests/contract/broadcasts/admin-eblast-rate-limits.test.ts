/**
 * F119 T026a (owner) · T062a (PR-2 extends) — the new write buckets on the
 * staff formatting routes and the member inline-image upload
 * (contracts/admin-eblast-formatting-api.md § Rate limits; spec § Roles).
 *
 *   staff  30 requests / 60 s per (tenant, actor):
 *     PATCH /api/admin/broadcasts/brand                 (T026)
 *     POST  /api/admin/broadcasts/[id]/images           (T106)
 *     POST  /api/admin/broadcasts/templates/[id]/images (T107)
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
