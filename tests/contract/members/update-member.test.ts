/**
 * T071 partial — Contract test: PATCH /api/members/[memberId] (US3).
 *
 * Covers the field-update + plan-change branches of the PATCH handler.
 * Mocks admin-context, idempotency, updateMember + changePlan use cases.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const updateMemberMock = vi.fn();
const changePlanMock = vi.fn();
const getMemberMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({})),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    updateMember: (...args: unknown[]) => updateMemberMock(...args),
    changePlan: (...args: unknown[]) => changePlanMock(...args),
    getMember: (...args: unknown[]) => getMemberMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => undefined),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: {
      id: 'admin-1',
      email: 'a@b.co',
      role: 'admin',
      status: 'active',
      displayName: 'A',
    },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-u1',
};

const validMemberId = '11111111-2222-3333-4444-555555555555';

const stubMember = {
  tenantId: 'test',
  memberId: validMemberId,
  companyName: 'X',
  legalEntityType: null,
  country: 'TH',
  taxId: null,
  website: null,
  description: null,
  foundedYear: null,
  turnoverThb: null,
  planId: 'regular',
  planYear: 2026,
  registrationDate: new Date('2026-01-01'),
  registrationFeePaid: false,
  lastActivityAt: null,
  notes: null,
  status: 'active' as const,
  archivedAt: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-u' },
): NextRequest {
  return new NextRequest(`http://localhost/api/members/${validMemberId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const routeParams = async () => ({ memberId: validMemberId });

describe('contract: PATCH /api/members/[memberId] (T071 / T090)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 on field update — happy path', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    updateMemberMock.mockResolvedValueOnce(
      ok({ ...stubMember, companyName: 'New Name' }),
    );
    const { PATCH } = await import('@/app/api/members/[memberId]/route');
    const res = await PATCH(makeRequest({ company_name: 'New Name' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.company_name).toBe('New Name');
  });

  it('400 invalid_body on zod fail', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    updateMemberMock.mockResolvedValueOnce(
      err({
        type: 'invalid_body',
        issues: [{ path: 'company_name', message: 'required' }],
      }),
    );
    const { PATCH } = await import('@/app/api/members/[memberId]/route');
    const res = await PATCH(makeRequest({}), { params: routeParams() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('404 on not_found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    updateMemberMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const { PATCH } = await import('@/app/api/members/[memberId]/route');
    const res = await PATCH(makeRequest({ company_name: 'X' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(404);
  });

  it('200 on plan change happy path', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    changePlanMock.mockResolvedValueOnce(
      ok({ ...stubMember, planId: 'premium' }),
    );
    const { PATCH } = await import('@/app/api/members/[memberId]/route');
    const res = await PATCH(
      makeRequest({ new_plan_id: 'premium', new_plan_year: 2026 }),
      { params: routeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan_id).toBe('premium');
  });

  it('409 bundle_change_requires_confirmation', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    changePlanMock.mockResolvedValueOnce(
      err({
        type: 'bundle_change_requires_confirmation',
        oldBundleCorporatePlanId: 'regular',
        newBundleCorporatePlanId: 'large',
      }),
    );
    const { PATCH } = await import('@/app/api/members/[memberId]/route');
    const res = await PATCH(
      makeRequest({ new_plan_id: 'gold', new_plan_year: 2026 }),
      { params: routeParams() },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('bundle_change_requires_confirmation');
    expect(body.error.details.newBundleCorporatePlanId).toBe('large');
  });

  it('422 turnover_warning on plan change', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    changePlanMock.mockResolvedValueOnce(
      err({
        type: 'turnover_out_of_band',
        turnoverThb: 500,
        band: { minThb: 1000, maxThb: null },
      }),
    );
    const { PATCH } = await import('@/app/api/members/[memberId]/route');
    const res = await PATCH(
      makeRequest({ new_plan_id: 'premium', new_plan_year: 2026 }),
      { params: routeParams() },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('turnover_warning');
  });

  it('400 missing Idempotency-Key', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { PATCH } = await import('@/app/api/members/[memberId]/route');
    const res = await PATCH(makeRequest({ company_name: 'X' }, {}), {
      params: routeParams(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
  });
});
