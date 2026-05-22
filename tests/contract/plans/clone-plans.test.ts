/**
 * T093 — Contract test: POST /api/plans/clone (US2).
 *
 * Asserts the clone-year response shape per contracts/plans-api.md § 9.
 * Mocks `@/lib/admin-context` + the `clonePlansToYear` application use
 * case so the handler runs without touching the real DB or session.
 * Real DB coverage lives in `tests/integration/plans/clone-idempotency.test.ts`.
 *
 * Scope:
 *   - 201 happy path with {source_year, target_year, cloned_count, cloned_plan_ids}
 *   - 409 target_year_populated (with existing_plan_ids detail)
 *   - 409 source_year_empty
 *   - 409 idempotency_conflict
 *   - 400 invalid_body (source == target)
 *   - 400 missing Idempotency-Key
 *   - 401 unauthenticated
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const clonePlansToYearMock = vi.fn();
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
    clonePlansToYear: (...args: unknown[]) => clonePlansToYearMock(...args),
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
  requestId: 'req-clone-1',
};

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-clone-1' },
): NextRequest {
  return new NextRequest('http://localhost/api/plans/clone', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('contract: POST /api/plans/clone (T093)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('201 on successful clone — returns summary with 9 cloned plan_ids', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    clonePlansToYearMock.mockResolvedValueOnce(
      ok({
        source_year: 2026,
        target_year: 2027,
        cloned_count: 9,
        cloned_plan_ids: [
          'premium',
          'large',
          'regular',
          'start-up',
          'individual',
          'thai-alumni',
          'diamond',
          'platinum',
          'gold',
        ],
      }),
    );

    const { POST } = await import('@/app/api/plans/clone/route');
    const res = await POST(
      makeRequest({ source_year: 2026, target_year: 2027, activate_cloned: false }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.source_year).toBe(2026);
    expect(body.target_year).toBe(2027);
    expect(body.cloned_count).toBe(9);
    expect(body.cloned_plan_ids).toHaveLength(9);
    expect(body.cloned_plan_ids).toContain('premium');
  });

  it('409 target_year_populated with existing_plan_ids detail', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    clonePlansToYearMock.mockResolvedValueOnce(
      err({
        type: 'target_year_populated',
        existing_count: 3,
        existing_plan_ids: ['existing-1', 'existing-2', 'existing-3'],
      }),
    );
    const { POST } = await import('@/app/api/plans/clone/route');
    const res = await POST(
      makeRequest({ source_year: 2026, target_year: 2027, activate_cloned: false }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.code).toBe('target_year_populated');
    expect(body.error?.details?.existing_count).toBe(3);
  });

  it('409 source_year_empty when no plans in source', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    clonePlansToYearMock.mockResolvedValueOnce(err({ type: 'source_year_empty' }));
    const { POST } = await import('@/app/api/plans/clone/route');
    const res = await POST(
      makeRequest({ source_year: 2030, target_year: 2031, activate_cloned: false }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.code).toBe('source_year_empty');
  });

  it('409 idempotency_conflict when key replayed with different body', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    clonePlansToYearMock.mockResolvedValueOnce(err({ type: 'idempotency_conflict' }));
    const { POST } = await import('@/app/api/plans/clone/route');
    const res = await POST(
      makeRequest({ source_year: 2026, target_year: 2027, activate_cloned: false }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.code).toBe('idempotency_conflict');
  });

  it('400 when source_year === target_year', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { POST } = await import('@/app/api/plans/clone/route');
    const res = await POST(
      makeRequest({ source_year: 2026, target_year: 2026, activate_cloned: false }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('invalid_body');
    expect(clonePlansToYearMock).not.toHaveBeenCalled();
  });

  it('400 when Idempotency-Key header missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { POST } = await import('@/app/api/plans/clone/route');
    const res = await POST(
      makeRequest(
        { source_year: 2026, target_year: 2027, activate_cloned: false },
        {},
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('missing_idempotency_key');
    expect(clonePlansToYearMock).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { POST } = await import('@/app/api/plans/clone/route');
    const res = await POST(
      makeRequest({ source_year: 2026, target_year: 2027, activate_cloned: false }),
    );
    expect(res.status).toBe(401);
    expect(clonePlansToYearMock).not.toHaveBeenCalled();
  });
});
