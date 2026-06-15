/**
 * 070 F8 item #18 contract test — POST `/api/admin/renewals/[cycleId]/reject`.
 *
 * Admin rejects a `pending_admin_reactivation` cycle + issues an F5 refund
 * (FR-005d). Money/refund endpoint → rate-limited 30/5min per (tenant,
 * admin) AFTER the RBAC gate, BEFORE the refund.
 *
 * Mirrors `admin-cancel-route.test.ts` (Proxy env + helper override) +
 * `send-reminder-now.test.ts` (rate-limiter mock). The use-case is mocked
 * so HTTP status ↔ error-kind mapping is asserted in isolation.
 *
 * Coverage:
 *   - kill-switch 503
 *   - manager 403 (helper-forwarded rejection)
 *   - 429 rate_limited (+Retry-After) BEFORE the use-case is called
 *   - rate-limit keyed by (tenant, admin)
 *   - 400 invalid_body (malformed JSON / missing reason / reason >500)
 *   - 200 happy path (refund issued) + no-payment variant (null credit-note)
 *   - cycle_not_found 404 / cycle_not_pending 409
 *   - refund_failed 502 (+errorCode/detail) / server_error 500
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const adminRejectReactivationMock = vi.fn();
const rateLimiterCheckMock = vi.fn(async () => ({ success: true, reset: 0 }));
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
  resolveTenantFromRequest: () => ({ slug: 'tenanta', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: () => rateLimiterCheckMock() },
}));
vi.mock('@/lib/rate-limit-helpers', () => ({
  retryAfterSecondsFromRl: vi.fn(() => 42),
}));
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    adminRejectReactivation: (...args: unknown[]) =>
      adminRejectReactivationMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000a01';
const ADMIN_CTX = {
  current: {
    user: {
      id: ADMIN_USER_ID,
      email: 'a@b.co',
      role: 'admin',
      status: 'active',
    },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-reject-1',
  correlationId: 'corr-reject-1',
};

const VALID_UUID = '00000000-0000-0000-0000-0000000000e1';

function makeReq(
  body: string | null = JSON.stringify({ reason: 'duplicate payment' }),
): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/renewals/${VALID_UUID}/reject`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ?? '',
    },
  );
}

function makeCtx() {
  return { params: Promise.resolve({ cycleId: VALID_UUID }) };
}

async function loadHandler() {
  const mod = await import('@/app/api/admin/renewals/[cycleId]/reject/route');
  return mod.POST;
}

describe('POST /api/admin/renewals/[cycleId]/reject — contract', () => {
  beforeEach(() => {
    f8FeatureFlag.value = true;
    rateLimiterCheckMock.mockResolvedValue({ success: true, reset: 0 });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('503 when feature flag off', { timeout: 30_000 }, async () => {
    f8FeatureFlag.value = false;
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(503);
    expect(adminRejectReactivationMock).not.toHaveBeenCalled();
  });

  it('passes through 403 from helper for manager', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: { code: 'forbidden' } }), {
        status: 403,
      }),
    });
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(403);
    // Rate-limit + use-case never reached when RBAC rejects.
    expect(rateLimiterCheckMock).not.toHaveBeenCalled();
    expect(adminRejectReactivationMock).not.toHaveBeenCalled();
  });

  it('429 rate_limited with Retry-After BEFORE the refund use-case', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    rateLimiterCheckMock.mockResolvedValueOnce({ success: false, reset: 999 });
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect((await res.json()).error.code).toBe('rate_limited');
    expect(adminRejectReactivationMock).not.toHaveBeenCalled();
  });

  it('keys the rate-limit by tenant + admin user id', async () => {
    const { rateLimiter } = await import('@/lib/auth-deps');
    const spy = vi.spyOn(rateLimiter, 'check');
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRejectReactivationMock.mockResolvedValueOnce(
      ok({
        cycleStatus: 'cancelled',
        closedReason: 'admin_rejected_with_refund',
        closedAt: '2026-06-14T10:00:00.000Z',
        refundCreditNoteId: 'cn-1',
      }),
    );
    const POST = await loadHandler();
    await POST(makeReq(), makeCtx());
    expect(spy).toHaveBeenCalledWith(
      `f8:reject-reactivation:tenanta:${ADMIN_USER_ID}`,
      30,
      300,
    );
    spy.mockRestore();
  });

  it('200 happy path (refund issued) with snake_case body', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRejectReactivationMock.mockResolvedValueOnce(
      ok({
        cycleStatus: 'cancelled',
        closedReason: 'admin_rejected_with_refund',
        closedAt: '2026-06-14T10:00:00.000Z',
        refundCreditNoteId: 'cn-42',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cycle_status).toBe('cancelled');
    expect(body.closed_reason).toBe('admin_rejected_with_refund');
    expect(body.closed_at).toBe('2026-06-14T10:00:00.000Z');
    expect(body.refund_credit_note_id).toBe('cn-42');
  });

  it('200 no-payment variant carries null refund_credit_note_id', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRejectReactivationMock.mockResolvedValueOnce(
      ok({
        cycleStatus: 'cancelled',
        closedReason: 'admin_rejected_with_refund',
        closedAt: '2026-06-14T10:00:00.000Z',
        refundCreditNoteId: null,
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(200);
    expect((await res.json()).refund_credit_note_id).toBe(null);
  });

  it('400 invalid_body on malformed JSON', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq('not-json'), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    expect(adminRejectReactivationMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body when reason missing', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq(JSON.stringify({})), makeCtx());
    expect(res.status).toBe(400);
    expect(adminRejectReactivationMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body when reason is blank after trim', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq(JSON.stringify({ reason: '   ' })), makeCtx());
    expect(res.status).toBe(400);
    expect(adminRejectReactivationMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body when reason exceeds 500 chars', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(JSON.stringify({ reason: 'x'.repeat(501) })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
    expect(adminRejectReactivationMock).not.toHaveBeenCalled();
  });

  // 070 speckit-review S5 — the four existing 400 cases all exercise the
  // zod-BODY path (`invalid_body`, use-case never called). The route ALSO
  // maps the use-case's own `invalid_input` arm → 400 (`invalid_input` code),
  // which had NO coverage. The reactivate route already tests this arm; mirror
  // it here so a regression that drops the `case 'invalid_input'` switch arm
  // (or remaps it) is caught.
  it('400 invalid_input from the use-case arm (distinct from invalid_body)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRejectReactivationMock.mockResolvedValueOnce(
      err({ kind: 'invalid_input', message: 'invalid cycle id' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(400);
    const body = await res.json();
    // The use-case arm surfaces `invalid_input` (NOT the body-parse
    // `invalid_body`) so the UI can distinguish a malformed body from a
    // use-case-level rejection.
    expect(body.error.code).toBe('invalid_input');
    // The use-case WAS reached (unlike the zod-body 400s).
    expect(adminRejectReactivationMock).toHaveBeenCalledOnce();
  });

  it('404 cycle_not_found', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRejectReactivationMock.mockResolvedValueOnce(
      err({ kind: 'cycle_not_found' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(404);
  });

  it('409 cycle_not_pending with current_status payload', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRejectReactivationMock.mockResolvedValueOnce(
      err({ kind: 'cycle_not_pending', currentStatus: 'lapsed' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('cycle_not_pending');
    expect(body.error.current_status).toBe('lapsed');
  });

  it('502 refund_failed with errorCode + detail', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRejectReactivationMock.mockResolvedValueOnce(
      err({
        kind: 'refund_failed',
        errorCode: 'processor_unavailable',
        detail: 'stripe 503',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('refund_failed');
    expect(body.error.error_code).toBe('processor_unavailable');
    expect(body.error.detail).toBe('stripe 503');
  });

  it('500 server_error', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRejectReactivationMock.mockResolvedValueOnce(
      err({ kind: 'server_error', message: 'boom' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });

  it('500 on unexpected throw', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminRejectReactivationMock.mockRejectedValueOnce(
      new Error('db: connection lost'),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });
});
