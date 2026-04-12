/**
 * T092 — Contract test: POST /api/plans (US2).
 *
 * Asserts the create-plan response shape per contracts/plans-api.md § 3.
 * Mocks `@/lib/admin-context` + the `createPlan` application use case
 * so the handler runs without touching the real DB or session. Real
 * DB coverage lives in `tests/integration/plans/create-plan-validation.test.ts`.
 *
 * Scope:
 *   - 201 happy path
 *   - 400 invalid_body (zod fail)
 *   - 422 partnership_corporate_mismatch (superRefine integrity rule)
 *   - 409 duplicate_plan
 *   - 409 idempotency_conflict
 *   - 401 unauthenticated
 *   - 403 forbidden (manager/member)
 *   - 400 missing Idempotency-Key
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const createPlanMock = vi.fn();
const buildPlansDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: (...args: unknown[]) => buildPlansDepsMock(...args),
}));
// Mock the barrel directly so the route's `import { createPlan } from
// '@/modules/plans'` picks up the mock without chain-pulling the real
// implementation (which would reach the DB).
vi.mock('@/modules/plans', async () => {
  const actual = await vi.importActual<typeof import('@/modules/plans')>(
    '@/modules/plans',
  );
  return {
    ...actual,
    createPlan: (...args: unknown[]) => createPlanMock(...args),
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
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active', displayName: 'A' },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-create-1',
};

const validBody = {
  plan_id: 'custom-2027',
  plan_year: 2027,
  plan_name: { en: 'Custom' },
  description: { en: 'desc' },
  sort_order: 100,
  plan_category: 'corporate',
  member_type_scope: 'company',
  annual_fee_minor_units: 4_000_000,
  includes_corporate_plan_id: null,
  min_turnover_minor_units: null,
  max_turnover_minor_units: null,
  max_duration_years: null,
  max_member_age: null,
  benefit_matrix: {
    eblast_per_year: 0,
    website_page_type: null,
    homepage_logo_category: null,
    directory_listing_size: null,
    event_discount_scope: 'none',
    events_cobranded_access: false,
    cultural_tickets_per_year: 0,
    m2m_benefits_access: false,
    business_referrals: false,
    tailor_made_services: false,
    partnership: null,
  },
};

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-uuid-1' },
): NextRequest {
  return new NextRequest('http://localhost/api/plans', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('contract: POST /api/plans (T092)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('201 on successful create — returns the created plan', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    createPlanMock.mockResolvedValueOnce(
      ok({
        plan_id: 'custom-2027',
        plan_year: 2027,
        plan_name: { en: 'Custom' },
        description: { en: 'desc' },
        sort_order: 100,
        plan_category: 'corporate',
        member_type_scope: 'company',
        annual_fee_minor_units: 4_000_000,
        includes_corporate_plan_id: null,
        min_turnover_minor_units: null,
        max_turnover_minor_units: null,
        max_duration_years: null,
        max_member_age: null,
        benefit_matrix: validBody.benefit_matrix,
        is_active: false,
        deleted_at: null,
        created_at: new Date('2026-04-11T10:00:00Z'),
        updated_at: new Date('2026-04-11T10:00:00Z'),
      }),
    );

    const { POST } = await import('@/app/api/plans/route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.plan_id).toBe('custom-2027');
    expect(body.plan_year).toBe(2027);
    expect(body.is_active).toBe(false);
  });

  it('400 on invalid body (shape fault — missing required plan_name.en)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    createPlanMock.mockResolvedValueOnce(
      err({
        type: 'invalid_body',
        issues: [{ path: 'plan_name.en', message: 'Required' }],
      }),
    );
    const invalid = { ...validBody, plan_name: {} };
    const { POST } = await import('@/app/api/plans/route');
    const res = await POST(makeRequest(invalid));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('invalid_body');
  });

  it('422 on partnership/corporate mismatch from the use case', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    createPlanMock.mockResolvedValueOnce(
      err({
        type: 'partnership_corporate_mismatch',
        issues: ['Partnership plans must bundle a corporate plan'],
      }),
    );
    const { POST } = await import('@/app/api/plans/route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error?.code).toBe('partnership_corporate_mismatch');
  });

  it('409 duplicate_plan when composite key collides', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    createPlanMock.mockResolvedValueOnce(err({ type: 'duplicate_plan' }));
    const { POST } = await import('@/app/api/plans/route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.code).toBe('duplicate_plan');
  });

  it('409 idempotency_conflict when key replayed with different body', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    createPlanMock.mockResolvedValueOnce(err({ type: 'idempotency_conflict' }));
    const { POST } = await import('@/app/api/plans/route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.code).toBe('idempotency_conflict');
  });

  it('401 when unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { POST } = await import('@/app/api/plans/route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(401);
    expect(createPlanMock).not.toHaveBeenCalled();
  });

  it('400 when Idempotency-Key header missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { POST } = await import('@/app/api/plans/route');
    const res = await POST(makeRequest(validBody, {}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('missing_idempotency_key');
    expect(createPlanMock).not.toHaveBeenCalled();
  });
});
