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

function makeReq(
  body: string | null = JSON.stringify({ plan_year: 2026 }),
): NextRequest {
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

  it('200 happy path with snake_case body — NO price field in the request', async () => {
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

    // The use-case input carries NO price field — only plan_year + actor.
    const useCaseInput = adminRenewLapsedMemberMock.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(useCaseInput.planYear).toBe(2026);
    expect(useCaseInput.actorRole).toBe('admin');
    expect('price' in useCaseInput).toBe(false);
    expect('frozenPlanPriceThb' in useCaseInput).toBe(false);
  });

  it('400 invalid_body on malformed JSON', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq('not-json'), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });

  it('400 invalid_body when plan_year missing', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq(JSON.stringify({})), makeCtx());
    expect(res.status).toBe(400);
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
