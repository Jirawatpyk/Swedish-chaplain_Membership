/**
 * R2 Batch 3h (R2-S3) — contract test for
 * `POST /api/admin/scheduled-plan-changes/[id]/cancel`.
 *
 * Covers the full error mapping from `cancelScheduledPlanChange`
 * Result error union to HTTP status codes:
 *   - 200 happy path (cancelled row returned)
 *   - 200 audit_failed — R3 Batch 4d (R3-S4): row IS cancelled, audit
 *     emit failed; return 200 with body + `X-Audit-Backfill-Required: 1`
 *     header (NOT 500 — mis-leads UI into retry).
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

const requireAdminContextMock = vi.fn();
const cancelScheduledPlanChangeMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
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
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
// R4-I2 — observe the new planMetrics.cancelAuditBackfillRequired
// counter. We mock the whole `@/lib/metrics` module so the assertion
// can inspect `planMetrics.cancelAuditBackfillRequired.mock.calls`.
vi.mock('@/lib/metrics', async () => {
  const actual = await vi.importActual<typeof import('@/lib/metrics')>(
    '@/lib/metrics',
  );
  return {
    ...actual,
    planMetrics: {
      ...actual.planMetrics,
      cancelAuditBackfillRequired: vi.fn(),
    },
  };
});

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
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
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
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
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
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
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
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
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
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
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
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
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

  // R3 Batch 4d (R3-S4) — audit_failed now returns 200 + diagnostic
  // header because the row IS cancelled at this point. The previous
  // 500 mis-led the UI into retrying a successful mutation. SRE alert
  // routing picks up the F2.PLAN_CHANGE.CANCEL_AUDIT_PERSIST_FAILED
  // errorId on the logger.error emit.
  const cancelledRow = {
    tenantId: 'test-swecham',
    scheduledChangeId: SCHEDULED_ID,
    memberId: MEMBER_ID,
    effectiveAtCycleId: CYCLE_ID,
    fromPlanId: 'corporate-regular',
    toPlanId: 'corporate-premier',
    scheduledByUserId: 'other-admin',
    reason: null,
    status: 'cancelled' as const,
    scheduledAt: '2026-05-01T00:00:00Z',
    appliedAt: null,
    supersededAt: null,
    cancelledAt: '2026-05-19T10:00:00Z',
  };

  it('200 audit_failed (auditErrorType=persist_failed) + X-Audit-Backfill-Required header', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockResolvedValueOnce(
      err({
        code: 'audit_failed',
        auditErrorType: 'persist_failed' as const,
        message: 'DB connection refused',
        transitioned: cancelledRow,
      }),
    );
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Audit-Backfill-Required')).toBe('1');
    expect(res.headers.get('X-Audit-Error-Type')).toBe('persist_failed');
    const body = await res.json();
    expect(body).toEqual({
      scheduled_change_id: SCHEDULED_ID,
      status: 'cancelled',
      cancelled_at: '2026-05-19T10:00:00Z',
    });
    // R4-I2 — metric counter increments with the audit_error_type label
    // so SRE backfill SLO can be graphed from OTel directly.
    const metricsMod = await import('@/lib/metrics');
    expect(metricsMod.planMetrics.cancelAuditBackfillRequired).toHaveBeenCalledWith(
      'test-swecham',
      'persist_failed',
    );
  });

  // invalid_payload discriminator maps to a distinct errorId in the
  // log + distinct X-Audit-Error-Type header.
  it('200 audit_failed (auditErrorType=invalid_payload) + X-Audit-Backfill-Required header', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockResolvedValueOnce(
      err({
        code: 'audit_failed',
        auditErrorType: 'invalid_payload' as const,
        message: 'payload.member_id: invalid',
        transitioned: cancelledRow,
      }),
    );
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Audit-Backfill-Required')).toBe('1');
    expect(res.headers.get('X-Audit-Error-Type')).toBe('invalid_payload');
    const body = await res.json();
    expect(body).toEqual({
      scheduled_change_id: SCHEDULED_ID,
      status: 'cancelled',
      cancelled_at: '2026-05-19T10:00:00Z',
    });
    // R4-I2 — metric counter label = 'invalid_payload' splits the
    // SRE dashboard differently from the persist_failed case above.
    const metricsMod = await import('@/lib/metrics');
    expect(metricsMod.planMetrics.cancelAuditBackfillRequired).toHaveBeenCalledWith(
      'test-swecham',
      'invalid_payload',
    );
  });

  it('500 server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockResolvedValueOnce(
      err({ code: 'server_error', message: 'postgres timeout' }),
    );
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });

  it('503 idempotency_reservation_failed when Upstash reserve returns err', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
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
    requireAdminContextMock.mockResolvedValueOnce({
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
    requireAdminContextMock.mockResolvedValueOnce({
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
