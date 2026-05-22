/**
 * T111 — Contract test: PATCH /api/plans/[year]/[planId] (US3).
 *
 * Asserts the update-plan response shape per contracts/plans-api.md § 4.
 * Mocks the auth context + idempotency + use case so the handler runs
 * without DB or session. Real DB coverage lives in:
 *   - tests/integration/plans/prior-year-lock.test.ts (T112)
 *   - tests/integration/plans/concurrent-edit-lww.test.ts (T113)
 *   - tests/integration/plans/audit-diff-update.test.ts (T114)
 *
 * Scope:
 *   - 200 on successful update (cosmetic field change)
 *   - 422 `prior_year_locked_fields` with details.locked_fields + suggested_action
 *   - 404 when plan not found
 *   - 422 `partnership_corporate_mismatch`
 *   - 409 `idempotency_conflict`
 *   - 401 unauthenticated
 *   - 400 missing Idempotency-Key
 *   - 400 invalid path (bad year/slug)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const updatePlanMock = vi.fn();
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
    updatePlan: (...args: unknown[]) => updatePlanMock(...args),
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
  reserveIdempotencyRecord: vi.fn(async () => ({ ok: true, value: { kind: 'reserved' as const } })),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'deterministic-hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active', displayName: 'A' },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-update-1',
};

const params = (year: string, planId: string) =>
  Promise.resolve({ year, planId });

function makeRequest(
  year: string,
  planId: string,
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-update-1' },
): NextRequest {
  return new NextRequest(`http://localhost/api/plans/${year}/${planId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const SAMPLE_PLAN = {
  plan_id: 'premium',
  plan_year: 2026,
  plan_name: { en: 'Premium Renamed' },
  description: { en: 'Test description' },
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
  is_active: true,
  deleted_at: null,
  created_at: new Date('2026-04-11T10:00:00Z'),
  updated_at: new Date('2026-04-11T10:00:00Z'),
};

describe('contract: PATCH /api/plans/[year]/[planId] (T111)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 on successful cosmetic update — returns the updated plan', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    updatePlanMock.mockResolvedValueOnce(ok(SAMPLE_PLAN));

    const { PATCH } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await PATCH(
      makeRequest('2026', 'premium', { plan_name: { en: 'Premium Renamed' } }),
      { params: params('2026', 'premium') },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan_id).toBe('premium');
    expect(body.plan_name.en).toBe('Premium Renamed');
  });

  it('422 prior_year_locked_fields with details.locked_fields + suggested_action', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    updatePlanMock.mockResolvedValueOnce(
      err({
        type: 'prior_year_locked_fields',
        locked_fields: ['annual_fee_minor_units'],
      }),
    );

    const { PATCH } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await PATCH(
      makeRequest('2026', 'premium', { annual_fee_minor_units: 4_000_000 }),
      { params: params('2026', 'premium') },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error?.code).toBe('prior_year_locked_fields');
    expect(body.error?.details?.locked_fields).toEqual(['annual_fee_minor_units']);
    expect(body.error?.details?.suggested_action).toBe('clone_to_current_year');
    expect(body.error?.details?.clone_action_path).toBe('/api/plans/clone');
  });

  it('404 when plan not found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    updatePlanMock.mockResolvedValueOnce(err({ type: 'not_found' }));

    const { PATCH } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await PATCH(
      makeRequest('2026', 'ghost', { plan_name: { en: 'X' } }),
      { params: params('2026', 'ghost') },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error?.code).toBe('not_found');
  });

  it('422 on partnership/corporate mismatch from the use case', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    updatePlanMock.mockResolvedValueOnce(
      err({
        type: 'partnership_corporate_mismatch',
        issues: ['Partnership plans must bundle a corporate plan'],
      }),
    );

    const { PATCH } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await PATCH(
      makeRequest('2026', 'premium', { plan_category: 'partnership' }),
      { params: params('2026', 'premium') },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error?.code).toBe('partnership_corporate_mismatch');
  });

  it('409 idempotency_conflict when key replayed with different body', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    updatePlanMock.mockResolvedValueOnce(err({ type: 'idempotency_conflict' }));

    const { PATCH } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await PATCH(
      makeRequest('2026', 'premium', { plan_name: { en: 'X' } }),
      { params: params('2026', 'premium') },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.code).toBe('idempotency_conflict');
  });

  it('401 when unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { PATCH } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await PATCH(
      makeRequest('2026', 'premium', { plan_name: { en: 'X' } }),
      { params: params('2026', 'premium') },
    );
    expect(res.status).toBe(401);
    expect(updatePlanMock).not.toHaveBeenCalled();
  });

  it('400 when Idempotency-Key header missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { PATCH } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await PATCH(
      makeRequest('2026', 'premium', { plan_name: { en: 'X' } }, {}),
      { params: params('2026', 'premium') },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('missing_idempotency_key');
    expect(updatePlanMock).not.toHaveBeenCalled();
  });

  it('400 on malformed path (uppercase slug)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { PATCH } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await PATCH(
      makeRequest('2026', 'Premium', { plan_name: { en: 'X' } }),
      { params: params('2026', 'Premium') },
    );
    expect(res.status).toBe(400);
    expect(updatePlanMock).not.toHaveBeenCalled();
  });
});
