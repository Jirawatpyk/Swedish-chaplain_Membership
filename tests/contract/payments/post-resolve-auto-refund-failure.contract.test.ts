/**
 * CF-2 — Contract test: POST /api/refunds/resolve-auto-refund-failure.
 *
 * Admin-only "mark failed auto-refund as reconciled" surface. Mirrors the
 * shape of `/api/refunds/initiate` (T101):
 *   - Auth via `requireAdminContext({ resource: 'refund', action: 'write' })`
 *     (manager → 403, no session → 401).
 *   - zod input validation (invalid_input on bad body).
 *   - 200 success envelope `{ outcome, correlationId }` on `reconciled` +
 *     `already_reconciled` (idempotent).
 *   - 409 no_failed_auto_refund when no failure forensic exists.
 *   - Response headers: X-Correlation-Id, Cache-Control: no-store, private.
 *   - i18n contract: error envelope carries `messageThai`.
 *   - Delegates the actual emit to the `resolveFailedAutoRefund` use-case.
 *
 * PCI / log hygiene: an unexpected use-case throw is caught + never surfaced.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const resolveFailedAutoRefundMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
  },
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-resolve-1',
}));

vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug, __brand: true }),
}));

vi.mock('@/modules/payments', () => ({
  resolveFailedAutoRefund: (...args: unknown[]) => resolveFailedAutoRefundMock(...args),
  makeResolveFailedAutoRefundDeps: () => ({ paymentsRepo: {}, audit: {} }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

async function getMockedAuthDeps() {
  const mod = await import('@/lib/auth-deps');
  return mod as unknown as { rateLimiter: { check: ReturnType<typeof vi.fn> } };
}

async function importRoute() {
  return (await import(
    '@/app/api/refunds/resolve-auto-refund-failure/route'
  )) as unknown as {
    POST: (req: NextRequest) => Promise<Response>;
  };
}

const adminContext = {
  current: {
    user: {
      id: 'user-admin-1',
      email: 'admin@swecham.test',
      role: 'admin' as const,
      status: 'active' as const,
      displayName: 'Admin One',
    },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.20',
  requestId: 'req-resolve-1',
};

function makeJsonRequest(body: unknown): NextRequest {
  return new NextRequest(
    'http://localhost/api/refunds/resolve-auto-refund-failure',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

const VALID_BODY = { invoiceId: 'inv_01JABCDEFGHIJKLMNOPQRSTUV' };

describe('contract: POST /api/refunds/resolve-auto-refund-failure (CF-2)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 — reconciled: response envelope { outcome, correlationId } + delegates to use-case', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resolveFailedAutoRefundMock.mockResolvedValueOnce(
      ok({ kind: 'reconciled', paymentId: 'pmt_1', processorRefundId: 're_1' }),
    );

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body['outcome']).toBe('reconciled');
    expect(body['correlationId']).toBeDefined();
    // The route wired the use-case with the invoiceId from the body.
    expect(resolveFailedAutoRefundMock).toHaveBeenCalledTimes(1);
    const input = resolveFailedAutoRefundMock.mock.calls[0]![1] as {
      invoiceId: string;
      actorUserId: string;
    };
    expect(input.invoiceId).toBe(VALID_BODY.invoiceId);
    expect(input.actorUserId).toBe('user-admin-1');
  });

  it('200 — already_reconciled is a benign idempotent success', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resolveFailedAutoRefundMock.mockResolvedValueOnce(
      ok({ kind: 'already_reconciled' }),
    );

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['outcome']).toBe('already_reconciled');
  });

  it('400 invalid_input — invoiceId missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('invalid_input');
  });

  it('401 unauthorized — no session', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'no-session' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    });

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('403 forbidden — manager session is rejected (admin-only surface)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    });

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('forbidden');
    // The use-case must NOT be reached on an auth failure.
    expect(resolveFailedAutoRefundMock).not.toHaveBeenCalled();
  });

  it('409 no_failed_auto_refund — nothing to reconcile for this invoice', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resolveFailedAutoRefundMock.mockResolvedValueOnce(
      err({ code: 'no_failed_auto_refund' }),
    );

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('no_failed_auto_refund');
    // i18n contract — bilingual envelope.
    expect(typeof error['messageThai']).toBe('string');
  });

  it('429 rate_limited — admin budget exceeded; carries Retry-After', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { rateLimiter } = await getMockedAuthDeps();
    rateLimiter.check.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 90_000,
    });

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).not.toBeNull();
  });

  it('500 internal_error — unexpected use-case throw is caught + never leaked', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resolveFailedAutoRefundMock.mockRejectedValueOnce(
      new Error('db connection lost'),
    );

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('db connection lost');
  });

  it('every response carries Cache-Control: no-store, private + X-Correlation-Id', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resolveFailedAutoRefundMock.mockResolvedValueOnce(
      ok({ kind: 'reconciled', paymentId: 'pmt_1', processorRefundId: 're_1' }),
    );

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    const cc = res.headers.get('Cache-Control');
    expect(cc).toContain('no-store');
    expect(cc).toContain('private');
    expect(res.headers.get('X-Correlation-Id')).not.toBeNull();
  });
});
