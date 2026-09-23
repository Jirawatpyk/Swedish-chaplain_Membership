/**
 * F119 T145 (US6-AS5, FR-039) — `GET /api/admin/broadcasts/quota?memberId=`.
 *
 * FR-039 asks the staff compose-on-behalf screen to show "the member's
 * allowance display". `GET /api/broadcasts/quota` resolves the member from the
 * SESSION (`requireMemberContext`), so a staff user can never read it for the
 * member they are composing for. This route reuses the same
 * `computeQuotaCounter` use case with the member taken from the query, and
 * returns the member route's response shape byte for byte so `QuotaDisplay`
 * renders it unchanged.
 *
 * Read-only: `broadcasts.read`, which a `manager` holds — the allowance is a
 * read, so the read-only role sees it (contract § Permission map).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { err, ok } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const computeQuotaCounterMock = vi.fn();

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
  computeQuotaCounter: (...args: unknown[]) => computeQuotaCounterMock(...args),
  makeComputeQuotaDeps: () => ({}),
}));
vi.mock('@/modules/members', () => ({
  // The brand is erased at runtime; the zod uuid check above is what makes
  // the value safe to brand.
  asMemberId: (id: string) => id,
}));

const MEMBER_ID = '22222222-2222-2222-2222-222222222222';

const staffCtx = (role: 'marketing' | 'manager') => ({
  current: {
    user: {
      id: 'user-mk-1',
      email: 'mk@swecham.test',
      role,
      status: 'active' as const,
      displayName: 'Mk',
    },
    session: { id: 'sess-1' },
  },
  requestId: 'req-admin-quota-1',
});

const QUOTA_OK = ok({
  counter: { used: 2, reserved: 1, remaining: 3, cap: 6 },
  quotaYear: 2026,
  planCode: 'premium_corporate',
  planId: 'plan-1',
  nextResetAt: '2026-12-31T17:00:00.000Z',
  tenantTimezone: 'Asia/Bangkok',
});

function req(query = `?memberId=${MEMBER_ID}`): NextRequest {
  return new NextRequest(`http://localhost/api/admin/broadcasts/quota${query}`, {
    method: 'GET',
  });
}

const importRoute = () => import('@/app/api/admin/broadcasts/quota/route');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  requireApiPermissionMock.mockResolvedValue(staffCtx('marketing'));
  computeQuotaCounterMock.mockResolvedValue(QUOTA_OK);
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/admin/broadcasts/quota', () => {
  it("returns the NAMED member's counter in the member route's shape", async () => {
    const { GET } = await importRoute();
    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(requireApiPermissionMock.mock.calls[0]![1]).toBe('broadcasts.read');
    expect(computeQuotaCounterMock.mock.calls[0]![1]).toEqual({ memberId: MEMBER_ID });
    // The member route's envelope, key for key — `QuotaDisplay` reads
    // `quotaYear/used/reserved/remaining/cap/planName` and must not learn a
    // second shape.
    expect(await res.json()).toEqual({
      planId: 'plan-1',
      planCode: 'premium_corporate',
      planName: 'Premium Corporate',
      eblastPerYear: 6,
      quotaYear: 2026,
      used: 2,
      reserved: 1,
      remaining: 3,
      cap: 6,
      nextResetAt: '2026-12-31T17:00:00.000Z',
      tenantTimezone: 'Asia/Bangkok',
    });
  });

  it('an unknown member → 404; a malformed or missing memberId → 400 before the use case runs', async () => {
    const { GET } = await importRoute();

    computeQuotaCounterMock.mockResolvedValueOnce(
      err({ kind: 'quota.member_not_found', memberId: MEMBER_ID }),
    );
    expect((await GET(req())).status).toBe(404);

    expect((await GET(req('?memberId=not-a-uuid'))).status).toBe(400);
    expect((await GET(req(''))).status).toBe(400);
    expect(computeQuotaCounterMock).toHaveBeenCalledTimes(1);
  });

  it('a manager (read-only) gets 200; the gate\'s 403 for a member session is returned untouched', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(staffCtx('manager'));
    const { GET } = await importRoute();
    expect((await GET(req())).status).toBe(200);

    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'permission_denied' }, { status: 403 }),
    });
    expect((await GET(req())).status).toBe(403);
    expect(computeQuotaCounterMock).toHaveBeenCalledTimes(1);
  });
});
