/**
 * F8-completion Slice 3 · Task 3.2 contract test —
 * POST `/api/admin/members/[id]/renew`.
 *
 * Mirrors `tests/contract/renewals/admin-cancel-route.test.ts`. Asserts
 * the route wiring: kill-switch, RBAC pass-through (admin-only — manager
 * 403 from the helper), body validation, and every error arm of the
 * `adminRenewLapsedMember` use-case mapped to its HTTP status.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const adminRenewLapsedMemberMock = vi.fn();
const f8FeatureFlag = { value: true };
const rateLimitCheckMock = vi.fn(async (..._args: unknown[]) => ({
  success: true,
  reset: Date.now() + 60_000,
}));

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === 'features') {
          return { ...target.features, f8Renewals: f8FeatureFlag.value };
        }
        return Reflect.get(target, prop);
      },
    }),
  };
});
vi.mock('@/lib/renewals-route-helpers', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/renewals-route-helpers')
  >('@/lib/renewals-route-helpers');
  return {
    ...actual,
    requireRenewalAdminContext: (...args: unknown[]) =>
      requireRenewalAdminContextMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    adminRenewLapsedMember: (...args: unknown[]) =>
      adminRenewLapsedMemberMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-3',
  correlationId: 'corr-3',
};

const MEMBER_UUID = '00000000-0000-0000-0000-0000000000a9';

function makeReq(body: string | null = JSON.stringify({})): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/members/${MEMBER_UUID}/renew`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ?? '',
    },
  );
}

function makeCtx() {
  return { params: Promise.resolve({ id: MEMBER_UUID }) };
}

async function loadHandler() {
  const mod = await import('@/app/api/admin/members/[id]/renew/route');
  return mod.POST;
}

describe('POST /api/admin/members/[id]/renew — contract', () => {
  beforeEach(() => {
    f8FeatureFlag.value = true;
    rateLimitCheckMock.mockResolvedValue({
      success: true,
      reset: Date.now() + 60_000,
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('503 when feature flag off', { timeout: 30_000 }, async () => {
    f8FeatureFlag.value = false;
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(503);
  });

  it('passes through 403 from helper for manager (admin-only write)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: { code: 'forbidden' } }), {
        status: 403,
      }),
    });
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(403);
    // The use-case must NOT run when the helper rejects.
    expect(adminRenewLapsedMemberMock).not.toHaveBeenCalled();
    // RBAC gate is BEFORE the rate-limit guard — a rejected manager must
    // not even consume a rate-limit token.
    expect(rateLimitCheckMock).not.toHaveBeenCalled();
  });

  it('requires the helper to be called with action="write"', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRenewLapsedMemberMock.mockResolvedValueOnce(
      ok({
        cycleId: 'cyc-1',
        invoiceId: 'inv-1',
        cycleStatus: 'awaiting_payment',
      }),
    );
    const POST = await loadHandler();
    await POST(makeReq(), makeCtx());
    expect(requireRenewalAdminContextMock).toHaveBeenCalledWith(
      expect.anything(),
      'write',
    );
  });

  it('200 happy path with EMPTY body — NO price and NO plan_year in the request (both server-derived)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRenewLapsedMemberMock.mockResolvedValueOnce(
      ok({
        cycleId: 'cyc-1',
        invoiceId: 'inv-1',
        cycleStatus: 'awaiting_payment',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cycle_id).toBe('cyc-1');
    expect(body.invoice_id).toBe('inv-1');
    expect(body.cycle_status).toBe('awaiting_payment');

    // L2: the use-case input carries NEITHER a price NOR a plan_year field —
    // both are server-derived (frozen price from the member's plan; plan_year
    // from the F4 fiscal-year of the fresh cycle's period_from). A §86/4 is a
    // tax document — the client cannot influence its year or amount.
    const useCaseInput = adminRenewLapsedMemberMock.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(useCaseInput.actorRole).toBe('admin');
    expect('planYear' in useCaseInput).toBe(false);
    expect('plan_year' in useCaseInput).toBe(false);
    expect('price' in useCaseInput).toBe(false);
    expect('frozenPlanPriceThb' in useCaseInput).toBe(false);
  });

  it('L2: a client-supplied plan_year in the body is IGNORED (server derives it) — still 200, no plan_year threaded to the use-case', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRenewLapsedMemberMock.mockResolvedValueOnce(
      ok({
        cycleId: 'cyc-1',
        invoiceId: 'inv-1',
        cycleStatus: 'awaiting_payment',
      }),
    );
    const POST = await loadHandler();
    // Attacker tries to pin a different fiscal year on the tax document.
    const res = await POST(makeReq(JSON.stringify({ plan_year: 1999 })), makeCtx());
    expect(res.status).toBe(200);
    const useCaseInput = adminRenewLapsedMemberMock.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect('planYear' in useCaseInput).toBe(false);
    expect('plan_year' in useCaseInput).toBe(false);
  });

  it('400 invalid_body on malformed JSON', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq('not-json'), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });

  it('L3: 429 rate_limited when the per-(tenant,admin) cap is exceeded — use-case NOT called', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    rateLimitCheckMock.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 120_000,
    });
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).toBeTruthy();
    // The money path must NOT run when rate-limited.
    expect(adminRenewLapsedMemberMock).not.toHaveBeenCalled();
  });

  it('L3: rate-limit is keyed per (tenant, admin) and runs AFTER the RBAC gate', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRenewLapsedMemberMock.mockResolvedValueOnce(
      ok({ cycleId: 'cyc-1', invoiceId: 'inv-1', cycleStatus: 'awaiting_payment' }),
    );
    const POST = await loadHandler();
    await POST(makeReq(), makeCtx());
    expect(rateLimitCheckMock).toHaveBeenCalledTimes(1);
    const key = rateLimitCheckMock.mock.calls[0]![0] as string;
    expect(key).toContain('test'); // tenant slug
    expect(key).toContain('admin-1'); // admin user id
  });

  it('404 member_not_found', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRenewLapsedMemberMock.mockResolvedValueOnce(
      err({ kind: 'member_not_found' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('member_not_found');
  });

  it('409 member_has_active_cycle', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRenewLapsedMemberMock.mockResolvedValueOnce(
      err({ kind: 'member_has_active_cycle' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('member_has_active_cycle');
  });

  it('409 member_archived (cluster C — archived member rejected before cycle creation)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRenewLapsedMemberMock.mockResolvedValueOnce(
      err({ kind: 'member_archived' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('member_archived');
  });

  it('422 plan_not_found', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRenewLapsedMemberMock.mockResolvedValueOnce(
      err({ kind: 'plan_not_found' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('plan_not_found');
  });

  it('502 invoice_issue_failed with stage payload', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRenewLapsedMemberMock.mockResolvedValueOnce(
      err({
        kind: 'invoice_issue_failed',
        stage: 'issue',
        errorCode: 'pdf_render_failed',
        detail: 'render timeout',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('invoice_issue_failed');
    expect(body.error.stage).toBe('issue');
  });

  it('500 server_error', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRenewLapsedMemberMock.mockResolvedValueOnce(
      err({ kind: 'server_error', message: 'boom' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(500);
  });

  it('500 on an unexpected throw from the use-case', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRenewLapsedMemberMock.mockRejectedValueOnce(new Error('db down'));
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(500);
  });
});
