/**
 * T094 — Contract test: POST /api/admin/broadcasts/[id]/reject.
 *
 * Wave 6 GREEN. Spec authority: contracts/broadcasts-api.md § 2.4.
 *
 * Verifies wire contract: zod input validation, success envelope shape,
 * authz, error code → HTTP status mapping (state-check, concurrency,
 * not-found, server-error). FR-012 sha256 invariant is verified at the
 * use-case unit-test level.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const rejectBroadcastMock = vi.fn();
const sendMemberEmailMock = vi.fn(async (..._args: unknown[]) => undefined);

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
  rejectBroadcast: (...args: unknown[]) => rejectBroadcastMock(...args),
  makeRejectBroadcastDeps: () => ({}),
  parseBroadcastId: (id: string) =>
    UUID_RE.test(id)
      ? { ok: true, value: id }
      : { ok: false, error: { kind: 'invalid_uuid' } },
  emailTransactionalBridge: {
    sendMemberEmail: (...args: unknown[]) => sendMemberEmailMock(...args),
  },
}));

const VALID_ID = '11111111-1111-1111-1111-111111111111';
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
  requestId: 'req-rej-1',
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
    `http://localhost/api/admin/broadcasts/${pathId}/reject`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { req, ctx: { params: Promise.resolve({ id: pathId }) } };
}

async function importRoute() {
  return import('@/app/api/admin/broadcasts/[id]/reject/route');
}

function broadcastFixture(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'test-tenant',
    broadcastId: VALID_ID,
    requestedByMemberId: 'm-1',
    requestedByMemberPlanIdSnapshot: 'p',
    submittedByUserId: 'u-1',
    actorRole: 'member_self_service',
    subject: 'Welcome',
    bodyHtml: '<p>x</p>',
    bodySource: 'plain',
    fromName: 'Chamber',
    replyToEmail: 'me@example.com',
    segmentType: 'all_members',
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: 10,
    status: 'rejected',
    submittedAt: new Date(),
    approvedAt: null,
    approvedByUserId: null,
    rejectedAt: new Date('2026-06-15T05:00:00Z'),
    rejectedByUserId: 'user-admin-1',
    rejectionReason: 'Off-topic',
    scheduledFor: null,
    sendingStartedAt: null,
    sentAt: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationReason: null,
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

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => vi.clearAllMocks());

describe('POST /api/admin/broadcasts/[id]/reject — Wave 6 GREEN (T094)', () => {
  it('200 happy: returns { broadcastId, status, rejectedAt, reservationReleased }', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    rejectBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture(),
        reservationReleased: true as const,
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: 'Off-topic for chamber' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      broadcastId: VALID_ID,
      status: 'rejected',
      reservationReleased: true,
    });
    expect(typeof body.rejectedAt).toBe('string');
  });

  it('200 happy: triggers best-effort member notification email with verbatim reason', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    rejectBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture(),
        reservationReleased: true as const,
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({
      rejectionReason: 'Verbatim reason here',
    });
    await POST(req, ctx);
    expect(sendMemberEmailMock).toHaveBeenCalledTimes(1);
    const callArgs = (sendMemberEmailMock.mock.calls[0] as unknown[])?.[1] as
      | { payload: { rejectionReason: string } }
      | undefined;
    expect(callArgs?.payload.rejectionReason).toBe('Verbatim reason here');
  });

  it('400 invalid_body: empty rejectionReason fails zod min(1)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: '' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(rejectBroadcastMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body: rejectionReason > 2000 chars fails zod max', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: 'x'.repeat(2001) });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: missing rejectionReason field', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({});
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: malformed JSON', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const req = new NextRequest(
      `http://localhost/api/admin/broadcasts/${VALID_ID}/reject`,
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

  it('404 broadcast_not_found: invalid uuid in path', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest(
      { rejectionReason: 'Reason' },
      'not-a-uuid',
    );
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_not_found');
    expect(rejectBroadcastMock).not.toHaveBeenCalled();
  });

  it('404 broadcast_not_found: use-case returns not_found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    rejectBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_not_found', broadcastId: VALID_ID }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_not_found');
  });

  it('409 broadcast_invalid_state_transition with observedStatus detail', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    rejectBroadcastMock.mockResolvedValueOnce(
      err({
        kind: 'broadcast_invalid_state_transition',
        observedStatus: 'cancelled',
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_invalid_state_transition');
    expect(body.error.details.observedStatus).toBe('cancelled');
  });

  it('409 broadcast_concurrent_action_blocked', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    rejectBroadcastMock.mockResolvedValueOnce(
      err({
        kind: 'broadcast_concurrent_action_blocked',
        observedStatus: 'rejected',
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_concurrent_action_blocked');
  });

  it('401: unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: unauthorisedResponse,
    });
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    expect(rejectBroadcastMock).not.toHaveBeenCalled();
  });

  it('403: manager role attempting reject (admin-context guard rejects write)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: forbiddenResponse,
    });
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
  });

  it('500 internal_error: use-case throws', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    rejectBroadcastMock.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal_error');
  });

  it('500 internal_error: use-case returns reject.server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    rejectBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'reject.server_error', message: 'db down' }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);
  });

  it('member email failure does NOT 5xx the request (best-effort branch)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    rejectBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture(),
        reservationReleased: true as const,
      }),
    );
    sendMemberEmailMock.mockRejectedValueOnce(new Error('resend down'));
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
  });

  it('correlation id present in success response headers', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    rejectBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture(),
        reservationReleased: true as const,
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ rejectionReason: 'Reason' });
    const res = await POST(req, ctx);
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });
});
