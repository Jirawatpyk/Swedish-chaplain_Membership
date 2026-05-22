/**
 * R2 Batch 3j (R2-S8) — contract tests for the shared `readOnlyModeResponse`
 * guard wired into the 8 F2 plan mutation routes.
 *
 * Pinned contracts:
 *   1. When `READ_ONLY_MODE=true`, every mutation route returns 503 +
 *      `Retry-After: 5` + body `{ error: { code: 'read_only_mode', ... } }`.
 *   2. The guard fires AFTER RBAC (admin-context) but BEFORE
 *      idempotency-guard + use-case invocation — proven by asserting
 *      the use-case mock is NEVER called.
 *   3. When `READ_ONLY_MODE=false` (default in tests), routes proceed
 *      normally — proven by the regular happy-path assertions in the
 *      sibling contract suites.
 *
 * Tests cover all 8 mutation handlers (one per route) so a future
 * refactor that drops the guard from any route fails this suite.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mock env BEFORE any route module imports.
vi.mock('@/lib/env', () => ({
  env: {
    flags: { readOnlyMode: true },
    // Provide minimal stubs so transitively-imported modules don't
    // crash on missing keys.
    features: {},
  },
}));

const requireAdminContextMock = vi.fn();
const createPlanMock = vi.fn();
const updatePlanMock = vi.fn();
const softDeletePlanMock = vi.fn();
const activatePlanMock = vi.fn();
const deactivatePlanMock = vi.fn();
const undeletePlanMock = vi.fn();
const clonePlansToYearMock = vi.fn();
const cancelScheduledPlanChangeMock = vi.fn();
const buildPlansDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: (...args: unknown[]) => buildPlansDepsMock(...args),
}));
vi.mock('@/modules/plans', async () => {
  const actual =
    await vi.importActual<typeof import('@/modules/plans')>('@/modules/plans');
  return {
    ...actual,
    createPlan: (...args: unknown[]) => createPlanMock(...args),
    updatePlan: (...args: unknown[]) => updatePlanMock(...args),
    softDeletePlan: (...args: unknown[]) => softDeletePlanMock(...args),
    activatePlan: (...args: unknown[]) => activatePlanMock(...args),
    deactivatePlan: (...args: unknown[]) => deactivatePlanMock(...args),
    undeletePlan: (...args: unknown[]) => undeletePlanMock(...args),
    clonePlansToYear: (...args: unknown[]) => clonePlansToYearMock(...args),
    cancelScheduledPlanChange: (...args: unknown[]) =>
      cancelScheduledPlanChangeMock(...args),
  };
});
vi.mock('@/modules/plans/server', () => ({
  drizzleScheduledPlanChangeRepo: {},
  planAuditAdapter: {},
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (h: Headers) => {
    const k = h.get('idempotency-key');
    return k ? { ok: true, key: k } : { ok: false, reason: 'missing' };
  },
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => ({
    ok: true,
    value: { kind: 'reserved' as const },
  })),
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
  requestId: 'req-ro-1',
};

function makeReq(
  url: string,
  body: unknown = {},
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
): NextRequest {
  // `RequestInit` from lib.dom has `signal: AbortSignal | null` which
  // Next's stricter `RequestInit` rejects under exactOptionalPropertyTypes.
  // Build the literal inline to let TS pick the narrower Next type.
  if (method === 'DELETE') {
    return new NextRequest(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'ro-1',
      },
    });
  }
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'ro-1' },
    body: JSON.stringify(body),
  });
}

const params = <T extends Record<string, string>>(p: T) => Promise.resolve(p);

beforeAll(() => {
  // Every test in this suite starts with a successful admin context.
  // Reset is via `afterEach`.
});

async function assert503ReadOnly(
  res: Response,
  useCaseMock: ReturnType<typeof vi.fn>,
): Promise<void> {
  expect(res.status).toBe(503);
  expect(res.headers.get('Retry-After')).toBe('5');
  const body = await res.json();
  expect(body.error.code).toBe('read_only_mode');
  // Use-case mock MUST NOT have been invoked — proves the guard
  // short-circuited BEFORE state-mutation work.
  expect(useCaseMock).not.toHaveBeenCalled();
}

describe('R2-S8: READ_ONLY_MODE 503 short-circuit across 8 F2 mutation routes', () => {
  afterEach(() => vi.clearAllMocks());

  it('POST /api/plans (create) → 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import('@/app/api/plans/route');
    const res = await POST(makeReq('http://x/api/plans', { x: 1 }));
    await assert503ReadOnly(res, createPlanMock);
  });

  it('POST /api/plans/clone → 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import('@/app/api/plans/clone/route');
    const res = await POST(
      makeReq('http://x/api/plans/clone', { source_year: 2025, target_year: 2026 }),
    );
    await assert503ReadOnly(res, clonePlansToYearMock);
  });

  it('PATCH /api/plans/[year]/[planId] → 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { PATCH } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await PATCH(
      makeReq('http://x/api/plans/2026/premium', { plan_name: { en: 'X' } }, 'PATCH'),
      { params: params({ year: '2026', planId: 'premium' }) },
    );
    await assert503ReadOnly(res, updatePlanMock);
  });

  it('DELETE /api/plans/[year]/[planId] → 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { DELETE } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await DELETE(
      makeReq('http://x/api/plans/2026/premium', {}, 'DELETE'),
      { params: params({ year: '2026', planId: 'premium' }) },
    );
    await assert503ReadOnly(res, softDeletePlanMock);
  });

  it('POST /api/plans/[year]/[planId]/activate → 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/activate/route'
    );
    const res = await POST(makeReq('http://x/api/plans/2026/premium/activate'), {
      params: params({ year: '2026', planId: 'premium' }),
    });
    await assert503ReadOnly(res, activatePlanMock);
  });

  it('POST /api/plans/[year]/[planId]/deactivate → 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/deactivate/route'
    );
    const res = await POST(makeReq('http://x/api/plans/2026/premium/deactivate'), {
      params: params({ year: '2026', planId: 'premium' }),
    });
    await assert503ReadOnly(res, deactivatePlanMock);
  });

  it('POST /api/plans/[year]/[planId]/undelete → 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/undelete/route'
    );
    const res = await POST(makeReq('http://x/api/plans/2026/premium/undelete'), {
      params: params({ year: '2026', planId: 'premium' }),
    });
    await assert503ReadOnly(res, undeletePlanMock);
  });

  it('POST /api/admin/scheduled-plan-changes/[id]/cancel → 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(
      makeReq(
        'http://x/api/admin/scheduled-plan-changes/33333333-3333-3333-3333-333333333333/cancel',
        {
          memberId: '11111111-1111-1111-1111-111111111111',
          effectiveAtCycleId: '22222222-2222-2222-2222-222222222222',
          reason: null,
        },
      ),
      { params: params({ id: '33333333-3333-3333-3333-333333333333' }) },
    );
    await assert503ReadOnly(res, cancelScheduledPlanChangeMock);
  });
});

// ============================================================
// R3 Batch 4a (R3-C4) — auth-before-readonly ordering
//
// The _read-only-guard.ts JSDoc explicitly warns: "Auth first (don't
// leak 503 to unauthenticated callers)." The above 8 happy-path tests
// only prove "readonly fires before use-case"; they DON'T prove "auth
// fires before readonly". A refactor swapping the order would
// silently leak 503 to unauthenticated callers.
//
// These 8 tests mock `requireAdminContext` to return a 401 response
// + assert the route returns 401 (NOT 503) under READ_ONLY_MODE=true.
// Use-case mocks MUST NOT be called.
// ============================================================

async function assert401NotReadOnly(
  res: Response,
  useCaseMock: ReturnType<typeof vi.fn>,
): Promise<void> {
  expect(res.status).toBe(401);
  expect(res.headers.get('Retry-After')).toBeNull();
  expect(useCaseMock).not.toHaveBeenCalled();
}

function unauthenticatedCtx(): { response: Response } {
  return {
    response: new Response(
      JSON.stringify({ error: { code: 'unauthenticated' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ),
  };
}

describe('R3-C4: auth fires BEFORE read-only-mode across 8 F2 mutation routes', () => {
  afterEach(() => vi.clearAllMocks());

  it('POST /api/plans (create): unauthenticated → 401 not 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(unauthenticatedCtx());
    const { POST } = await import('@/app/api/plans/route');
    const res = await POST(makeReq('http://x/api/plans', { x: 1 }));
    await assert401NotReadOnly(res, createPlanMock);
  });

  it('POST /api/plans/clone: unauthenticated → 401 not 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(unauthenticatedCtx());
    const { POST } = await import('@/app/api/plans/clone/route');
    const res = await POST(
      makeReq('http://x/api/plans/clone', {
        source_year: 2025,
        target_year: 2026,
      }),
    );
    await assert401NotReadOnly(res, clonePlansToYearMock);
  });

  it('PATCH /api/plans/[year]/[planId]: unauthenticated → 401 not 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(unauthenticatedCtx());
    const { PATCH } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await PATCH(
      makeReq(
        'http://x/api/plans/2026/premium',
        { plan_name: { en: 'X' } },
        'PATCH',
      ),
      { params: params({ year: '2026', planId: 'premium' }) },
    );
    await assert401NotReadOnly(res, updatePlanMock);
  });

  it('DELETE /api/plans/[year]/[planId]: unauthenticated → 401 not 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(unauthenticatedCtx());
    const { DELETE } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await DELETE(
      makeReq('http://x/api/plans/2026/premium', {}, 'DELETE'),
      { params: params({ year: '2026', planId: 'premium' }) },
    );
    await assert401NotReadOnly(res, softDeletePlanMock);
  });

  it('POST /api/plans/[year]/[planId]/activate: unauthenticated → 401 not 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(unauthenticatedCtx());
    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/activate/route'
    );
    const res = await POST(makeReq('http://x/api/plans/2026/premium/activate'), {
      params: params({ year: '2026', planId: 'premium' }),
    });
    await assert401NotReadOnly(res, activatePlanMock);
  });

  it('POST /api/plans/[year]/[planId]/deactivate: unauthenticated → 401 not 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(unauthenticatedCtx());
    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/deactivate/route'
    );
    const res = await POST(
      makeReq('http://x/api/plans/2026/premium/deactivate'),
      { params: params({ year: '2026', planId: 'premium' }) },
    );
    await assert401NotReadOnly(res, deactivatePlanMock);
  });

  it('POST /api/plans/[year]/[planId]/undelete: unauthenticated → 401 not 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(unauthenticatedCtx());
    const { POST } = await import(
      '@/app/api/plans/[year]/[planId]/undelete/route'
    );
    const res = await POST(makeReq('http://x/api/plans/2026/premium/undelete'), {
      params: params({ year: '2026', planId: 'premium' }),
    });
    await assert401NotReadOnly(res, undeletePlanMock);
  });

  it('POST /api/admin/scheduled-plan-changes/[id]/cancel: unauthenticated → 401 not 503', async () => {
    requireAdminContextMock.mockResolvedValueOnce(unauthenticatedCtx());
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(
      makeReq(
        'http://x/api/admin/scheduled-plan-changes/33333333-3333-3333-3333-333333333333/cancel',
        {
          memberId: '11111111-1111-1111-1111-111111111111',
          effectiveAtCycleId: '22222222-2222-2222-2222-222222222222',
          reason: null,
        },
      ),
      { params: params({ id: '33333333-3333-3333-3333-333333333333' }) },
    );
    await assert401NotReadOnly(res, cancelScheduledPlanChangeMock);
  });
});
