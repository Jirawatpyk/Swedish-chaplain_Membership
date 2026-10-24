/**
 * R2 Batch 3h (R2-S3) — contract test for
 * `POST /api/admin/scheduled-plan-changes/[id]/cancel`.
 *
 * Covers the full error mapping from `cancelScheduledPlanChange`
 * Result error union to HTTP status codes:
 *   - 200 happy path (cancelled row returned)
 *   - 500 audit_failed — 126 #7: the audit is written in the cancel's
 *     tx, so the cancel rolled back and a retry is safe.
 *   - 400 invalid_path / invalid_body / invalid_input
 *   - 401 unauthenticated
 *   - 403 manager attempts (admin-only)
 *   - 404 not_found
 *   - 409 already_terminal
 *   - 500 server_error
 *   - 503 idempotency_reservation_failed (Upstash outage)
 *
 * Mocks the auth context, idempotency, use-case, and `@/modules/plans/server`
 * adapters so the handler runs without DB.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const cancelScheduledPlanChangeMock = vi.fn();

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/modules/plans', async () => {
  const actual = await vi.importActual<typeof import('@/modules/plans')>(
    '@/modules/plans',
  );
  return {
    ...actual,
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
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => ({
    ok: true,
    value: { kind: 'reserved' as const },
  })),
  releaseIdempotencyRecord: vi.fn(async (..._a: unknown[]) => undefined),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: {
      id: 'admin-uuid',
      email: 'admin@swecham.test',
      role: 'admin',
      status: 'active',
      displayName: 'A',
    },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-cancel-1',
};

// R3 Batch 4a (R3-C2) — use a real UUID; the route path schema now
// enforces `z.string().uuid()`. The pre-R3 value `'sched-uuid-001'`
// would now fail the new path validation.
const SCHEDULED_ID = '33333333-3333-3333-3333-333333333333';
const MEMBER_ID = '11111111-1111-1111-1111-111111111111';
const CYCLE_ID = '22222222-2222-2222-2222-222222222222';

const validBody = {
  memberId: MEMBER_ID,
  effectiveAtCycleId: CYCLE_ID,
  reason: null,
};

const params = (id: string) => Promise.resolve({ id });

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-cancel-1' },
): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/scheduled-plan-changes/${SCHEDULED_ID}/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
  );
}

describe('contract: POST /api/admin/scheduled-plan-changes/[id]/cancel (R2-S3)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 happy path — returns the cancelled scheduled-plan-change envelope', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockResolvedValueOnce(
      ok({
        tenantId: 'test-swecham',
        scheduledChangeId: SCHEDULED_ID,
        memberId: MEMBER_ID,
        effectiveAtCycleId: CYCLE_ID,
        fromPlanId: 'corporate-regular',
        toPlanId: 'corporate-premier',
        scheduledByUserId: 'other-admin',
        reason: null,
        status: 'cancelled',
        scheduledAt: '2026-05-01T00:00:00Z',
        appliedAt: null,
        supersededAt: null,
        cancelledAt: '2026-05-19T10:00:00Z',
      }),
    );

    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), { params: params(SCHEDULED_ID) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      scheduled_change_id: SCHEDULED_ID,
      status: 'cancelled',
      cancelled_at: '2026-05-19T10:00:00Z',
    });
  });

  it('400 missing Idempotency-Key', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody, {}), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
  });

  it('400 invalid_body when memberId is not a UUID', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(
      makeRequest({ ...validBody, memberId: 'not-a-uuid' }),
      { params: params(SCHEDULED_ID) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('400 invalid_input from the use-case (zod failure post-handler)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockResolvedValueOnce(
      err({ code: 'invalid_input', field: 'scheduledChangeId' }),
    );
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_input');
  });

  it('404 not_found when use-case returns not_found', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockResolvedValueOnce(
      err({ code: 'not_found', scheduledChangeId: SCHEDULED_ID }),
    );
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('409 already_terminal with status in details', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockResolvedValueOnce(
      err({
        code: 'already_terminal',
        scheduledChangeId: SCHEDULED_ID,
        status: 'applied' as const,
      }),
    );
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('already_terminal');
    expect(body.error.details.status).toBe('applied');
  });

  // 126 #7 — the audit row is written in the cancel's tx, so audit_failed
  // means the cancel ROLLED BACK: a plain retryable 500 (no body to cache,
  // reservation released), never the old 200 + X-Audit-Backfill-Required.
  // The errorId still splits zod-rejection from DB-rejection for alerting.
  for (const [auditErrorType, errorId] of [
    ['persist_failed', 'F2.PLAN_CHANGE.CANCEL_AUDIT_PERSIST_FAILED'],
    ['invalid_payload', 'F2.PLAN_CHANGE.CANCEL_AUDIT_INVALID_PAYLOAD'],
  ] as const) {
    it(`500 audit_failed (${auditErrorType}) — rolled back, logged ${errorId}, not cached`, async () => {
      requireApiPermissionMock.mockResolvedValueOnce(adminContext);
      cancelScheduledPlanChangeMock.mockResolvedValueOnce(
        err({ code: 'audit_failed', auditErrorType, message: 'simulated' }),
      );
      const loggerMod = await import('@/lib/logger');
      const errorSpy = vi.mocked(loggerMod.logger.error);
      errorSpy.mockClear();
      const idem = await import('@/lib/idempotency');
      vi.mocked(idem.rememberIdempotentResponse).mockClear();
      vi.mocked(idem.releaseIdempotencyRecord).mockClear();

      const { POST } = await import(
        '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
      );
      const res = await POST(makeRequest(validBody), {
        params: params(SCHEDULED_ID),
      });
      expect(res.status).toBe(500);
      expect(res.headers.get('X-Audit-Backfill-Required')).toBeNull();
      const body = await res.json();
      expect(body.error.code).toBe('audit_failed');
      const [structured] = errorSpy.mock.calls[0]! as [{ errorId: string }, string];
      expect(structured.errorId).toBe(errorId);
      expect(vi.mocked(idem.rememberIdempotentResponse)).not.toHaveBeenCalled();
      // The reservation is released, so the client's retry (same key, same
      // body) is not refused as a conflict — the cancel never happened.
      expect(vi.mocked(idem.releaseIdempotencyRecord)).toHaveBeenCalledWith(
        expect.anything(),
        'idem-cancel-1',
      );
    });
  }

  // R5-I1 + R5-I11 — `case 'server_error':` now emits a SINGLE
  // logger.error with `errorId: 'F2.PLAN_CHANGE.CANCEL_SERVER_ERROR'`
  // when no recheck failure, or `…_RECHECK_FAILED` when the inner
  // recheck threw. Previously the route fired BOTH logger.warn
  // (errorId tagged) AND logger.error (untagged) on the recheck
  // branch — alert-rule double-firing risk.
  it('500 server_error (no recheck) — single logger.error with F2.PLAN_CHANGE.CANCEL_SERVER_ERROR', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockResolvedValueOnce(
      err({
        code: 'server_error',
        recheckFailed: false as const,
        message: 'postgres timeout',
      }),
    );
    const loggerMod = await import('@/lib/logger');
    const errorSpy = vi.mocked(loggerMod.logger.error);
    const warnSpy = vi.mocked(loggerMod.logger.warn);
    errorSpy.mockClear();
    warnSpy.mockClear();

    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    const [structured] = errorSpy.mock.calls[0]! as [
      { errorId: string; recheckErrMessage?: string },
      string,
    ];
    expect(structured.errorId).toBe('F2.PLAN_CHANGE.CANCEL_SERVER_ERROR');
    expect(structured.recheckErrMessage).toBeUndefined();
  });

  // 117 — the 5xx arm must RELEASE the reservation the shared guard made. A
  // reserved-but-unwritten record classifies as a CONFLICT for 24 h, so the
  // client's correct retry (same key, same body) could never succeed.
  it('117: releases the idempotency reservation on the 500 arm', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockResolvedValueOnce(
      err({
        code: 'server_error',
        recheckFailed: false as const,
        message: 'postgres timeout',
      }),
    );
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(500);
    const idem = await import('@/lib/idempotency');
    expect(vi.mocked(idem.rememberIdempotentResponse)).not.toHaveBeenCalled();
    expect(vi.mocked(idem.releaseIdempotencyRecord)).toHaveBeenCalledWith(
      expect.anything(),
      'idem-cancel-1',
    );
  });

  // 117 — a THROWN error must release too: the `default:` arm calls
  // `assertNever`, and a use case that throws escapes the same way. The
  // release is in a `finally`, so the rejection still propagates.
  it('117: releases the idempotency reservation when the use case throws', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    await expect(
      POST(makeRequest(validBody), { params: params(SCHEDULED_ID) }),
    ).rejects.toThrow('boom');
    const idem = await import('@/lib/idempotency');
    expect(vi.mocked(idem.releaseIdempotencyRecord)).toHaveBeenCalledWith(
      expect.anything(),
      'idem-cancel-1',
    );
  });

  it('500 server_error (recheck failed) — single logger.error with F2.PLAN_CHANGE.CANCEL_RECHECK_FAILED + recheckErrMessage field', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockResolvedValueOnce(
      err({
        code: 'server_error',
        recheckFailed: true as const,
        message: 'transitionStatus failed',
        recheckErrMessage: 'rls: connection-pool exhausted',
      }),
    );
    const loggerMod = await import('@/lib/logger');
    const errorSpy = vi.mocked(loggerMod.logger.error);
    const warnSpy = vi.mocked(loggerMod.logger.warn);
    errorSpy.mockClear();
    warnSpy.mockClear();

    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(500);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    const [structuredRecheck] = errorSpy.mock.calls[0]! as [
      { errorId: string; recheckErrMessage?: string },
      string,
    ];
    expect(structuredRecheck.errorId).toBe(
      'F2.PLAN_CHANGE.CANCEL_RECHECK_FAILED',
    );
    expect(structuredRecheck.recheckErrMessage).toBe(
      'rls: connection-pool exhausted',
    );
  });

  it('503 idempotency_reservation_failed when Upstash reserve returns err', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    const idem = await import('@/lib/idempotency');
    vi.mocked(idem.reserveIdempotencyRecord).mockResolvedValueOnce({
      ok: false,
      error: { kind: 'redis_unavailable', message: 'EAI_AGAIN' },
    });
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    const body = await res.json();
    expect(body.error.code).toBe('idempotency_reservation_failed');
    expect(cancelScheduledPlanChangeMock).not.toHaveBeenCalled();
  });

  // R3 Batch 4c (R3-I11) — RBAC cases. Sibling F2 plan routes ship
  // 401 + 403 tests; cancel route was missing them.
  it('401 unauthenticated', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ error: { code: 'unauthenticated' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    });
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(401);
    expect(cancelScheduledPlanChangeMock).not.toHaveBeenCalled();
  });

  it('403 manager attempts (write requires admin)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          error: { code: 'forbidden', message: 'admin role required' },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    });
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(403);
    expect(cancelScheduledPlanChangeMock).not.toHaveBeenCalled();
  });
});
