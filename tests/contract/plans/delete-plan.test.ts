/**
 * T123 — Contract test: DELETE /api/plans/[year]/[planId] (US4 FR-010).
 *
 * Scope:
 *   - 200 on successful soft-delete (stub returns 0 members)
 *   - 409 plan_has_active_members with details.affected_member_count
 *   - 404 when plan not found
 *   - 401 unauthenticated
 *   - 400 missing Idempotency-Key
 *
 * Mocks the auth context + idempotency + use case so the handler runs
 * without DB or session. The 409 path is mock-only in F2 because the
 * real `MemberAttachmentChecker` stub always returns 0 — real F3
 * coverage lands when the members table exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const softDeletePlanMock = vi.fn();
const buildPlansDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: (...args: unknown[]) => buildPlansDepsMock(...args),
}));
vi.mock('@/modules/plans', async () => {
  const actual = await vi.importActual<typeof import('@/modules/plans')>(
    '@/modules/plans',
  );
  return {
    ...actual,
    softDeletePlan: (...args: unknown[]) => softDeletePlanMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
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
  hashRequestBody: vi.fn(() => 'deterministic-hash'),
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
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-delete-1',
};

const params = (year: string, planId: string) =>
  Promise.resolve({ year, planId });

function makeRequest(
  year: string,
  planId: string,
  headers: Record<string, string> = { 'idempotency-key': 'idem-del-1' },
): NextRequest {
  return new NextRequest(`http://localhost/api/plans/${year}/${planId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const SAMPLE_DELETED_PLAN = {
  plan_id: 'premium',
  plan_year: 2026,
  plan_name: { en: 'Premium' },
  description: { en: '' },
  sort_order: 10,
  plan_category: 'corporate' as const,
  member_type_scope: 'company' as const,
  annual_fee_minor_units: 3_600_000,
  includes_corporate_plan_id: null,
  min_turnover_minor_units: null,
  max_turnover_minor_units: null,
  max_duration_years: null,
  max_member_age: null,
  benefit_matrix: {},
  is_active: false,
  deleted_at: new Date('2026-04-11T10:00:00Z'),
  created_at: new Date('2026-04-11T10:00:00Z'),
  updated_at: new Date('2026-04-11T10:00:00Z'),
};

describe('contract: DELETE /api/plans/[year]/[planId] (T123)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 on successful soft-delete — returns plan with deleted_at set', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    softDeletePlanMock.mockResolvedValueOnce(ok(SAMPLE_DELETED_PLAN));

    const { DELETE } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await DELETE(makeRequest('2026', 'premium'), {
      params: params('2026', 'premium'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan_id).toBe('premium');
    expect(body.deleted_at).not.toBeNull();
  });

  it('409 plan_has_active_members with details.affected_member_count', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    softDeletePlanMock.mockResolvedValueOnce(
      err({ type: 'has_active_members', count: 3 }),
    );

    const { DELETE } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await DELETE(makeRequest('2026', 'premium'), {
      params: params('2026', 'premium'),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.code).toBe('plan_has_active_members');
    expect(body.error?.details?.affected_member_count).toBe(3);
  });

  it('404 when plan not found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    softDeletePlanMock.mockResolvedValueOnce(err({ type: 'not_found' }));

    const { DELETE } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await DELETE(makeRequest('2026', 'ghost'), {
      params: params('2026', 'ghost'),
    });
    expect(res.status).toBe(404);
  });

  it('401 when unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { DELETE } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await DELETE(makeRequest('2026', 'premium'), {
      params: params('2026', 'premium'),
    });
    expect(res.status).toBe(401);
    expect(softDeletePlanMock).not.toHaveBeenCalled();
  });

  it('400 when Idempotency-Key header missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { DELETE } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await DELETE(makeRequest('2026', 'premium', {}), {
      params: params('2026', 'premium'),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('missing_idempotency_key');
    expect(softDeletePlanMock).not.toHaveBeenCalled();
  });
});
