/**
 * F8 Phase 3 Wave H3 · T066 contract test —
 * POST `/api/admin/renewals/[cycleId]/mark-paid-offline`.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const markPaidOfflineMock = vi.fn();
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
  requestId: 'req-4',
  correlationId: 'corr-4',
};

const VALID_UUID = '00000000-0000-0000-0000-0000000000c6';

function makeBody(overrides?: Partial<Record<string, unknown>>): string {
  return JSON.stringify({
    payment_method: 'bank_transfer',
    payment_reference: 'BT-2026-0042',
    payment_date: '2026-05-15',
    ...(overrides ?? {}),
  });
}

function makeReq(body: string | null = null): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/renewals/${VALID_UUID}/mark-paid-offline`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ?? makeBody(),
    },
  );
}

function makeCtx() {
  return { params: Promise.resolve({ cycleId: VALID_UUID }) };
}

async function loadHandler() {
  const mod = await import(
    '@/app/api/admin/renewals/[cycleId]/mark-paid-offline/route'
  );
  return mod.POST;
}

describe('POST /api/admin/renewals/[cycleId]/mark-paid-offline — contract', () => {
  beforeEach(() => {
    f8FeatureFlag.value = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('503 when feature flag off', async () => {
    f8FeatureFlag.value = false;
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(503);
  });

  it('200 happy path', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(
      ok({
        cycleStatus: 'completed',
        invoiceId: 'inv-1',
        newExpiresAt: '2028-06-01T00:00:00.000Z',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cycle_status).toBe('completed');
    expect(body.invoice_id).toBe('inv-1');
    expect(body.new_expires_at).toBe('2028-06-01T00:00:00.000Z');
  });

  it('400 invalid_body on malformed JSON', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq('not-json'), makeCtx());
    expect(res.status).toBe(400);
  });

  it('400 invalid_body on bad payment_method', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(makeBody({ payment_method: 'crypto' })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_body on bad payment_date format', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(makeBody({ payment_date: '15-05-2026' })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it('404 cycle_not_found', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(err({ kind: 'cycle_not_found' }));
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(404);
  });

  it('409 cycle_not_payable with current_status', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(
      err({ kind: 'cycle_not_payable', currentStatus: 'completed' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.current_status).toBe('completed');
  });

  it('502 f4_failure with stage but reason scrubbed (W-02)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(
      err({
        kind: 'f4_failure',
        stage: 'create_invoice_failed',
        reason: 'plan_not_found',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('f4_failure');
    expect(body.error.stage).toBe('create_invoice_failed');
    // Round 6 B-R5-2 — Round 5 W-02 scrubs the F4-internal `reason`
    // from the HTTP response body so internal schema / column / row
    // fragments cannot leak to the admin UI. Reason is logged
    // server-side via `logger.warn` for ops triage.
    expect(body.error).not.toHaveProperty('reason');
  });

  it('400 invalid_body when payment_reference is PAN-like (W-01)', async () => {
    // Round 6 S-R5-2 — contract-layer guard so a future regression
    // that drops the zod `refine` cannot land silently. 16 consecutive
    // digits = canonical raw-paste card-number error pattern.
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(makeBody({ payment_reference: '4111111111111111' })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(markPaidOfflineMock).not.toHaveBeenCalled();
  });

  it('200 happy path accepts Thai bank reference format YYYYMMDD-NNNNN (B-R5-1 regression guard)', async () => {
    // Round 6 B-R5-1 — Round 5's PAN regex `(\d[\s-]?){13,19}` falsely
    // blocked legitimate Thai bank reference format. The fixed regex
    // requires 13+ CONSECUTIVE digits (no separators) so this passes.
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    markPaidOfflineMock.mockResolvedValueOnce(
      ok({
        cycleStatus: 'completed' as const,
        invoiceId: 'inv-1',
        newExpiresAt: '2027-06-01T00:00:00Z',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(
      makeReq(makeBody({ payment_reference: 'KTB-20260504-12345' })),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    expect(markPaidOfflineMock).toHaveBeenCalled();
  });
});
