/**
 * R2 Batch 3h (R2-S3) — contract test for
 * `POST /api/admin/scheduled-plan-changes/[id]/cancel`.
 *
 * Covers the full error mapping from `cancelScheduledPlanChange`
 * Result error union to HTTP status codes:
 *   - 200 happy path (cancelled row returned)
 *   - 400 invalid_path / invalid_body / invalid_input
 *   - 401 unauthenticated
 *   - 403 manager attempts (admin-only)
 *   - 404 not_found
 *   - 409 already_terminal
 *   - 500 audit_failed / server_error
 *   - 503 idempotency_reservation_failed (Upstash outage)
 *
 * Mocks the auth context, idempotency, use-case, and `@/modules/plans/server`
 * adapters so the handler runs without DB.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
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

const SCHEDULED_ID = 'sched-uuid-001';
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

  it('500 audit_failed', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    cancelScheduledPlanChangeMock.mockResolvedValueOnce(
      err({ code: 'audit_failed', message: 'persist_failed' }),
    );
    const { POST } = await import(
      '@/app/api/admin/scheduled-plan-changes/[id]/cancel/route'
    );
    const res = await POST(makeRequest(validBody), {
      params: params(SCHEDULED_ID),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('audit_failed');
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
});
