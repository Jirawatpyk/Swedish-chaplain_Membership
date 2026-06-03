/**
 * Contract test — W0-17 rate-limit on POST /api/portal/renewal/[memberId]/confirm.
 *
 * The confirm endpoint composes F4 invoice draft + issuance (a money path), so it must
 * be rate-limited. This test locks the limiter's POSITION: when the bucket is exhausted
 * the route returns 429 + Retry-After and `confirmRenewal` (the invoice work) is NEVER
 * reached. The use-case itself is covered by tests/unit/renewals/.../confirm-renewal.test.ts.
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
  selfServiceFailureReason: vi.fn(),
}));
// Mock the route helpers so the test doesn't pull the real module's transitive
// chain (which reads request.url in its role-guard helpers); errorResponse here is
// a faithful, minimal stand-in (envelope + status + merged headers).
vi.mock('@/lib/renewals-route-helpers', () => ({
  errorResponse: (opts: {
    status: number;
    code: string;
    correlationId?: string;
    headers?: Record<string, string>;
  }) =>
    NextResponse.json(
      { error: { code: opts.code }, correlationId: opts.correlationId },
      { status: opts.status, headers: opts.headers },
    ),
  successResponse: (body: unknown, _cid: string, status = 200) =>
    NextResponse.json(body, { status }),
}));

function confirmReq() {
  return new NextRequest('http://localhost/api/portal/renewal/mem-1/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cycleId: '11111111-1111-1111-1111-111111111111', planYear: 2026 }),
  });
}
const ctx = { params: Promise.resolve({ memberId: 'mem-1' }) };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  f8Flag = true;
  rlSuccess = true;
  memberCtx = { memberId: 'mem-1', tenant: { slug: 'swecham' }, current: { user: { id: 'u-1', role: 'member' } } };
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/portal/renewal/[memberId]/confirm — rate-limit (W0-17)', () => {
  const route = () => import('@/app/api/portal/renewal/[memberId]/confirm/route');

  it('rate-limited → 429 + Retry-After, confirmRenewal (money path) NOT reached', async () => {
    rlSuccess = false;
    const res = await (await route()).POST(confirmReq(), ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    const body = await res.json();
    expect(body.error.code).toBe('rate_limited');
    // The whole point of W0-17: the limiter gates the F4 invoice work.
    expect(confirmRenewalMock).not.toHaveBeenCalled();
  });

  it('limiter open → request proceeds past the limiter into confirmRenewal', async () => {
    // With the limiter open, the request must reach the F4 invoice work. confirmRenewal
    // resolves a typed Result error (server_error) so the route maps it via the normal
    // switch (502/500 path) rather than the outer catch — what we assert is simply that
    // the money path WAS reached, proving the limiter does not block a legitimate request.
    confirmRenewalMock.mockResolvedValue({ ok: false, error: { kind: 'server_error' } });
    const res = await (await route()).POST(confirmReq(), ctx);
    expect(confirmRenewalMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
  });
});
