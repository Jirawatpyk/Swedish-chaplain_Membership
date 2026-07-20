/**
 * Contract test — WP4 downgrade acknowledgement on
 * POST /api/portal/renewal/[memberId]/confirm.
 *
 * Pins the wire contract for the plan-downgrade gate:
 *   • `acknowledgeDowngrade:true` in the body forwards `{ acknowledgeDowngrade:
 *     true }` to the use-case; omitting the key (or sending an honest `false`,
 *     C-9) forwards NO such property and never 400s;
 *   • a `downgrade_not_acknowledged` use-case error maps to HTTP 409 echoing
 *     the server-derived `current_price_minor_units` / `new_price_minor_units`
 *     / `currency` (the client never posts a price).
 *
 * The use-case is mocked — its behaviour is covered by
 * tests/unit/renewals/.../confirm-renewal.test.ts + the live-Neon integration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

let f8Flag = true;
let rlSuccess = true;
let memberCtx: unknown;
const confirmRenewalMock = vi.fn();

vi.mock('@/lib/env', () => ({
  env: { features: { get f8Renewals() { return f8Flag; } } },
}));
vi.mock('@/lib/member-context', () => ({
  requireMemberContext: () => Promise.resolve(memberCtx),
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: () => Promise.resolve({ success: rlSuccess, reset: 9_999_999_999_999, limit: 10, remaining: 0 }),
  },
}));
vi.mock('@/lib/rate-limit-helpers', () => ({ retryAfterSecondsFromRl: () => 3600 }));
vi.mock('@/lib/otel-tracer', () => ({
  renewalsTracer: () => ({}),
  withActiveSpan: (_t: unknown, _n: unknown, _a: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@/lib/metrics', () => ({ renewalsMetrics: { selfServiceFailed: vi.fn() } }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/renewals', () => ({
  confirmRenewal: (...a: unknown[]) => confirmRenewalMock(...a),
  makeRenewalsDeps: () => ({}),
  selfServiceFailureReason: vi.fn(() => 'downgrade_unacknowledged'),
}));
vi.mock('@/lib/renewals-route-helpers', () => ({
  errorResponse: (opts: {
    status: number;
    code: string;
    correlationId?: string;
    headers?: Record<string, string>;
    details?: unknown;
  }) =>
    NextResponse.json(
      { error: { code: opts.code, ...(opts.details ? { details: opts.details } : {}) }, correlationId: opts.correlationId },
      { status: opts.status, ...(opts.headers ? { headers: opts.headers } : {}) },
    ),
  successResponse: (body: unknown, _cid: string, status = 200) =>
    NextResponse.json(body, { status }),
}));

const CYCLE_ID = '11111111-1111-1111-1111-111111111111';

function confirmReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/portal/renewal/mem-1/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ memberId: 'mem-1' }) };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  f8Flag = true;
  rlSuccess = true;
  memberCtx = { memberId: 'mem-1', tenant: { slug: 'swecham' }, current: { user: { id: 'u-1', role: 'member' } }, requestId: 'req-1' };
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/portal/renewal/[memberId]/confirm — downgrade ack (WP4)', () => {
  const route = () => import('@/app/api/portal/renewal/[memberId]/confirm/route');

  it('forwards acknowledgeDowngrade:true to the use-case when the body sends it', async () => {
    confirmRenewalMock.mockResolvedValue({
      ok: true,
      value: { invoiceId: 'inv-1', invoiceNumber: 'INV-1', payUrl: '/portal/invoices/inv-1?pay=1', planChanged: true },
    });
    const res = await (await route()).POST(
      confirmReq({ cycleId: CYCLE_ID, newPlanId: 'regular', acknowledgeDowngrade: true }),
      ctx,
    );
    expect(res.status).toBe(200);
    const input = confirmRenewalMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.acknowledgeDowngrade).toBe(true);
    expect(input.newPlanId).toBe('regular');
  });

  it('omitting acknowledgeDowngrade forwards NO such property (exactOptionalPropertyTypes)', async () => {
    confirmRenewalMock.mockResolvedValue({
      ok: true,
      value: { invoiceId: 'inv-1', invoiceNumber: 'INV-1', payUrl: '/portal/invoices/inv-1?pay=1', planChanged: true },
    });
    await (await route()).POST(confirmReq({ cycleId: CYCLE_ID, newPlanId: 'regular' }), ctx);
    const input = confirmRenewalMock.mock.calls[0]![1] as Record<string, unknown>;
    expect('acknowledgeDowngrade' in input).toBe(false);
  });

  it('an honest acknowledgeDowngrade:false is NOT a 400 and forwards no ack (C-9)', async () => {
    confirmRenewalMock.mockResolvedValue({
      ok: false,
      error: { kind: 'downgrade_not_acknowledged', currentPriceMinorUnits: 5_000_000, newPriceMinorUnits: 3_000_000, currency: 'THB' },
    });
    const res = await (await route()).POST(
      confirmReq({ cycleId: CYCLE_ID, newPlanId: 'regular', acknowledgeDowngrade: false }),
      ctx,
    );
    // Reached the use-case (409, not a 400 invalid_body).
    expect(confirmRenewalMock).toHaveBeenCalledTimes(1);
    const input = confirmRenewalMock.mock.calls[0]![1] as Record<string, unknown>;
    expect('acknowledgeDowngrade' in input).toBe(false);
    expect(res.status).toBe(409);
  });

  it('downgrade_not_acknowledged → 409 echoing the server-derived prices + currency', async () => {
    confirmRenewalMock.mockResolvedValue({
      ok: false,
      error: { kind: 'downgrade_not_acknowledged', currentPriceMinorUnits: 5_000_000, newPriceMinorUnits: 3_000_000, currency: 'THB' },
    });
    const res = await (await route()).POST(
      confirmReq({ cycleId: CYCLE_ID, newPlanId: 'regular' }),
      ctx,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('downgrade_not_acknowledged');
    expect(body.error.details).toMatchObject({
      current_price_minor_units: 5_000_000,
      new_price_minor_units: 3_000_000,
      currency: 'THB',
    });
  });
});
