/**
 * Contract test — `POST /api/admin/renewals/[cycleId]/mark-paid-offline`.
 *
 * This route is the money path in the F8 renewals surface: it records an
 * out-of-band payment and drives the F4 invoice/receipt chain. Its outer
 * catch logged a full pino line but **no `errorId`**, and
 * `docs/runbooks/audit-emit-loss.md` tells SRE to pin alert rules to that
 * field rather than to message text — so a 500 here matched no rule.
 *
 * Two distinct ways the catch is reached, because they fail differently:
 *
 *   1. The use-case THROWS (DB outage, F4 chain blowing up). The catch has
 *      always run for this one; it just carried nothing to alert on.
 *   2. The use-case returns an error KIND this build's `switch` has no arm
 *      for (deploy skew). This route's `default` returns a 500 directly and
 *      logs NOTHING, so the money path went silent on exactly the failure
 *      mode that means "two versions disagree". Routing it through
 *      `assertNever` puts it in the catch with the other one.
 *
 * Mocks auth context, env flags, tenant resolver, logger and `markPaidOffline`
 * so the handler runs without a DB.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const markPaidOfflineMock = vi.fn();
const f8FeatureFlag = { value: true };
const loggerErrorMock = vi.fn();

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
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorMock,
    debug: vi.fn(),
  },
}));
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    markPaidOffline: (...args: unknown[]) => markPaidOfflineMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-mpo-1',
  correlationId: 'corr-mpo-1',
};

const CYCLE_ID = '00000000-0000-0000-0000-0000000000c1';

function makeReq(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/renewals/${CYCLE_ID}/mark-paid-offline`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payment_method: 'bank_transfer',
        payment_reference: 'TRF-2026-0912',
        payment_date: '2026-09-07',
      }),
    },
  );
}

function makeCtx() {
  return { params: Promise.resolve({ cycleId: CYCLE_ID }) };
}

async function loadHandler() {
  const mod = await import(
    '@/app/api/admin/renewals/[cycleId]/mark-paid-offline/route'
  );
  return mod.POST;
}

describe('contract: POST /api/admin/renewals/[cycleId]/mark-paid-offline — errorId', () => {
  afterEach(() => {
    vi.clearAllMocks();
    f8FeatureFlag.value = true;
  });

  it('502 — a mapped error kind does not reach the catch', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(
      err({ kind: 'f4_failure', stage: 'issue-invoice', reason: 'boom' }),
    );

    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());

    expect(res.status).toBe(502);
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('500 on a thrown use-case — the catch carries an errorId an alert rule can key on', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockRejectedValueOnce(new Error('neon: connection lost'));

    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());

    expect(res.status).toBe(500);
    const body = (await res.json()) as { correlationId?: string };
    expect(body.correlationId).toBe('corr-mpo-1');
    // `code-conventions.md` says all three of these tests assert the
    // correlationId "in body and header"; this one asserted only the body,
    // so deleting the header from `errorResponse` would have left the money
    // path's test green. Making the doc true rather than softening it.
    expect(res.headers.get('X-Correlation-Id')).toBe('corr-mpo-1');

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [structured] = loggerErrorMock.mock.calls[0]!;
    expect(structured.errorId).toBe('F8.CYCLE_MARK_PAID_OFFLINE.UNEXPECTED');
    expect(structured.correlationId).toBe('corr-mpo-1');
  });

  it('500 on an unmapped error KIND — deploy skew is logged, not silently 500ed', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(
      err({ kind: 'settlement_window_locked_in_a_future_release' }),
    );

    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());

    expect(res.status).toBe(500);
    const body = (await res.json()) as { correlationId?: string };
    expect(body.correlationId).toBe('corr-mpo-1');

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [structured] = loggerErrorMock.mock.calls[0]!;
    expect(structured.errorId).toBe('F8.CYCLE_MARK_PAID_OFFLINE.UNEXPECTED');
    // The thrown message must name the kind — that string is what tells the
    // on-call which use-case variant this build cannot map.
    expect(String(structured.err)).toContain(
      'settlement_window_locked_in_a_future_release',
    );
  });
});
