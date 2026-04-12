/**
 * T124 — Contract test: POST /api/plans/[year]/[planId]/undelete (US4 AS4).
 *
 * Scope:
 *   - 200 on successful undelete — returned plan has `deleted_at: null`
 *     AND `is_active: false` (US4 AS4: undelete target state is Inactive,
 *     never directly Active).
 *   - 404 when plan not found
 *   - 401 unauthenticated
 *   - 400 missing Idempotency-Key
 *
 * The repo forces `is_active = false` on undelete (see plan-repo.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const undeletePlanMock = vi.fn();
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
    undeletePlan: (...args: unknown[]) => undeletePlanMock(...args),
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
  requestId: 'req-undelete-1',
};

const params = (year: string, planId: string) =>
  Promise.resolve({ year, planId });

function makeRequest(
  year: string,
  planId: string,
  headers: Record<string, string> = { 'idempotency-key': 'idem-undel-1' },
): NextRequest {
  return new NextRequest(
    `http://localhost/api/plans/${year}/${planId}/undelete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({}),
    },
  );
}

const SAMPLE_RESTORED_PLAN = {
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
  is_active: false, // AS4: undelete always restores to inactive
  deleted_at: null,
  created_at: new Date('2026-04-11T10:00:00Z'),
  updated_at: new Date('2026-04-11T10:00:00Z'),
};

describe('contract: POST /api/plans/[year]/[planId]/undelete (T124)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 on successful undelete — deleted_at cleared, is_active forced false (AS4)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    undeletePlanMock.mockResolvedValueOnce(ok(SAMPLE_RESTORED_PLAN));

    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/undelete/route'
    );
    const res = await POST(makeRequest('2026', 'premium'), {
      params: params('2026', 'premium'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted_at).toBeNull();
    expect(body.is_active).toBe(false);
  });

  it('404 when plan not found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    undeletePlanMock.mockResolvedValueOnce(err({ type: 'not_found' }));

    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/undelete/route'
    );
    const res = await POST(makeRequest('2026', 'ghost'), {
      params: params('2026', 'ghost'),
    });
    expect(res.status).toBe(404);
  });

  it('401 when unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/undelete/route'
    );
    const res = await POST(makeRequest('2026', 'premium'), {
      params: params('2026', 'premium'),
    });
    expect(res.status).toBe(401);
    expect(undeletePlanMock).not.toHaveBeenCalled();
  });

  it('403 when manager role attempts undelete', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json(
        { error: { code: 'forbidden', message: 'Insufficient permissions.' } },
        { status: 403 },
      ),
    });
    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/undelete/route'
    );
    const res = await POST(makeRequest('2026', 'premium'), {
      params: params('2026', 'premium'),
    });
    expect(res.status).toBe(403);
    expect(undeletePlanMock).not.toHaveBeenCalled();
  });

  it('500 when audit write fails on undelete', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    undeletePlanMock.mockResolvedValueOnce(
      err({ type: 'audit_failed', message: 'db down' }),
    );

    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/undelete/route'
    );
    const res = await POST(makeRequest('2026', 'premium'), {
      params: params('2026', 'premium'),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error?.code).toBe('audit_failed');
  });

  it('400 when Idempotency-Key header missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/undelete/route'
    );
    const res = await POST(makeRequest('2026', 'premium', {}), {
      params: params('2026', 'premium'),
    });
    expect(res.status).toBe(400);
    expect(undeletePlanMock).not.toHaveBeenCalled();
  });
});
