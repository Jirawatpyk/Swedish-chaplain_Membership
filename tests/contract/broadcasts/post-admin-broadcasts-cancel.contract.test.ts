/**
 * T111 — Contract test: POST /api/admin/broadcasts/[id]/cancel.
 *
 * DV-12 GREEN. Spec authority: contracts/broadcasts-api.md § 2.5.
 *
 * Verifies wire contract: zod input validation, success envelope shape,
 * authz, error code → HTTP status mapping (state-cutoff, concurrency,
 * not-found, server-error).
 * FR-004a: admin-cancel REQUIRES a cancellationReason (≤500 chars).
 * State-cutoff: only `submitted` / `approved` cancellable (else 409
 * `broadcast_cancel_too_late`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const cancelBroadcastMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
vi.mock('@/modules/broadcasts', () => ({
  cancelBroadcast: (...args: unknown[]) => cancelBroadcastMock(...args),
  makeCancelBroadcastDeps: () => ({}),
  parseBroadcastId: (id: string) =>
    UUID_RE.test(id)
      ? { ok: true, value: id }
      : { ok: false, error: { kind: 'invalid_uuid' } },
  tenantDefaultLocaleFor: () => 'en',
}));

const VALID_ID = '22222222-2222-2222-2222-222222222222';
const adminCtx = {
  current: {
    user: {
      id: 'user-admin-1',
      email: 'admin@swecham.test',
      role: 'admin' as const,
      status: 'active' as const,
      displayName: 'Admin',
    },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.10',
  requestId: 'req-cancel-1',
};
const unauthorisedResponse = NextResponse.json(
  { error: 'unauthorized' },
  { status: 401 },
);
const forbiddenResponse = NextResponse.json(
  { error: 'forbidden' },
  { status: 403 },
);

function makeRequest(
  body: unknown,
  pathId = VALID_ID,
): { req: NextRequest; ctx: { params: Promise<{ id: string }> } } {
  const req = new NextRequest(
    `http://localhost/api/admin/broadcasts/${pathId}/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { req, ctx: { params: Promise.resolve({ id: pathId }) } };
}

async function importRoute() {
  return import('@/app/api/admin/broadcasts/[id]/cancel/route');
}

function broadcastFixture(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'test-tenant',
    broadcastId: VALID_ID,
    requestedByMemberId: 'm-1',
    requestedByMemberPlanIdSnapshot: 'p',
    submittedByUserId: 'u-1',
    actorRole: 'member_self_service',
    subject: 'Monthly Update',
    bodyHtml: '<p>x</p>',
    bodySource: 'plain',
    fromName: 'Chamber',
    replyToEmail: 'me@example.com',
    segmentType: 'all_members',
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: 10,
    status: 'cancelled',
    submittedAt: new Date(),
    approvedAt: null,
    approvedByUserId: null,
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
    scheduledFor: null,
    sendingStartedAt: null,
    sentAt: null,
    cancelledAt: new Date('2026-06-15T06:00:00Z'),
    cancelledByUserId: 'user-admin-1',
    cancellationReason: 'Admin-cancelled for testing',
    failedToDispatchAt: null,
    failureReason: null,
    quotaYearConsumed: null,
    quotaConsumedAt: null,
    resendAudienceId: null,
    resendBroadcastId: null,
    retentionYears: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/admin/broadcasts/[id]/cancel — DV-12 (T111)', () => {
  // ── Success path ──────────────────────────────────────────────────────────

  it('200 happy: returns { broadcastId, status, cancelledAt, reservationReleased }', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture(),
        reservationReleased: true as const,
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'Event moved to next month' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      broadcastId: VALID_ID,
      status: 'cancelled',
      reservationReleased: true,
    });
    expect(typeof body.cancelledAt).toBe('string');
  });

  it('200 happy: passes verbatim cancellationReason to use-case', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture(),
        reservationReleased: true as const,
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({
      cancellationReason: 'Verbatim cancellation reason here',
    });
    await POST(req, ctx);
    expect(cancelBroadcastMock).toHaveBeenCalledTimes(1);
    const useCaseInput = (cancelBroadcastMock.mock.calls[0] as unknown[])?.[1] as
      | { cancellationReason: string }
      | undefined;
    expect(useCaseInput?.cancellationReason).toBe('Verbatim cancellation reason here');
  });

  // ── Auth / RBAC ───────────────────────────────────────────────────────────

  it('401: unauthenticated request', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: unauthorisedResponse,
    });
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    expect(cancelBroadcastMock).not.toHaveBeenCalled();
  });

  it('403: manager role attempting cancel (admin-context guard rejects write)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: forbiddenResponse,
    });
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect(cancelBroadcastMock).not.toHaveBeenCalled();
  });

  // ── Input validation (400) ────────────────────────────────────────────────

  it('400 invalid_body: empty cancellationReason fails zod min(1)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: '' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(cancelBroadcastMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body: cancellationReason > 500 chars fails zod max(500)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'x'.repeat(501) });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(cancelBroadcastMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body: missing cancellationReason field', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({});
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('400 invalid_body: malformed JSON', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const req = new NextRequest(
      `http://localhost/api/admin/broadcasts/${VALID_ID}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      },
    );
    const { POST } = await importRoute();
    const res = await POST(req, {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(400);
  });

  // ── Path validation (404) ─────────────────────────────────────────────────

  it('404 broadcast_not_found: invalid uuid in path', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest(
      { cancellationReason: 'Reason' },
      'not-a-uuid',
    );
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_not_found');
    expect(cancelBroadcastMock).not.toHaveBeenCalled();
  });

  it('404 broadcast_not_found: use-case returns not_found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_not_found', broadcastId: VALID_ID }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_not_found');
  });

  // ── 409 state-machine errors ──────────────────────────────────────────────

  it('409 broadcast_cancel_too_late with observedStatus detail', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      err({
        kind: 'broadcast_cancel_too_late',
        observedStatus: 'sent',
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_cancel_too_late');
    expect(body.error.details.observedStatus).toBe('sent');
  });

  it('409 broadcast_concurrent_action_blocked with observedStatus detail', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      err({
        kind: 'broadcast_concurrent_action_blocked',
        observedStatus: 'cancelled',
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_concurrent_action_blocked');
    expect(body.error.details.observedStatus).toBe('cancelled');
  });

  // ── Server errors (500) ───────────────────────────────────────────────────

  it('500 internal_error: use-case throws unexpectedly', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    cancelBroadcastMock.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal_error');
  });

  it('500 internal_error: use-case returns cancel.server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'cancel.server_error', message: 'db down' }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal_error');
  });

  // ── Observability ─────────────────────────────────────────────────────────

  it('correlation id present in success response headers', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture(),
        reservationReleased: true as const,
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });
});
