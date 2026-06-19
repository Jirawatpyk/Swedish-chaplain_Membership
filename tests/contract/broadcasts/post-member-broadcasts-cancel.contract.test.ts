/**
 * DV-12 — Contract test: POST /api/broadcasts/[id]/cancel (member path).
 *
 * Spec authority: contracts/broadcasts-api.md § 2.6.
 *
 * Verifies wire contract: zod input validation, success envelope shape,
 * member auth (401/403), cross-member forbidden (404), error code →
 * HTTP status mapping (state-cutoff, concurrency, not-found, server-error).
 * FR-004a: member cancel reason is OPTIONAL (≤500 chars).
 * Owns-the-broadcast: use-case returns broadcast_not_found when caller is
 * not the originating member (existence leak prevention).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const cancelBroadcastMock = vi.fn();

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
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

const VALID_ID = '33333333-3333-3333-3333-333333333333';
const memberCtx = {
  current: {
    user: {
      id: 'user-member-1',
      email: 'member@swecham.test',
      role: 'member' as const,
      status: 'active' as const,
      displayName: 'Test Member',
    },
    session: { id: 'sess-member-1' },
  },
  tenant: { slug: 'test-tenant', __brand: true as const },
  member: {
    memberId: 'm-111',
    tenantId: 'test-tenant',
    status: 'active',
    displayName: 'Test Member',
  },
  memberId: 'm-111' as unknown as import('@/modules/members/domain/member').MemberId,
  ownContact: { contactId: 'c-1', memberId: 'm-111' },
  ownContactId: 'c-1' as unknown as import('@/modules/members/domain/contact').ContactId,
  sourceIp: '203.0.113.20' as const,
  requestId: 'req-member-cancel-1' as const,
};
const unauthorisedResponse = NextResponse.json(
  { error: 'no-session' },
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
    `http://localhost/api/broadcasts/${pathId}/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { req, ctx: { params: Promise.resolve({ id: pathId }) } };
}

async function importRoute() {
  return import('@/app/api/broadcasts/[id]/cancel/route');
}

function broadcastFixture(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'test-tenant',
    broadcastId: VALID_ID,
    requestedByMemberId: 'm-111',
    requestedByMemberPlanIdSnapshot: 'p',
    submittedByUserId: 'user-member-1',
    actorRole: 'member_self_service',
    subject: 'Member Update',
    bodyHtml: '<p>x</p>',
    bodySource: 'plain',
    fromName: 'Chamber',
    replyToEmail: 'me@example.com',
    segmentType: 'all_members',
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: 5,
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
    cancelledAt: new Date('2026-06-19T08:00:00Z'),
    cancelledByUserId: 'user-member-1',
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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/broadcasts/[id]/cancel — DV-12 member path (T113)', () => {
  // ── Success paths ─────────────────────────────────────────────────────────

  it('200 happy: no reason (member reason is optional)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    // Aggregate status is deliberately NOT 'cancelled' here so the assertion
    // proves the route returns the literal status: 'cancelled' on success
    // (its documented contract), rather than merely echoing the fixture.
    cancelBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture({ status: 'approved' }),
        reservationReleased: true as const,
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({});
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      broadcastId: VALID_ID,
      status: 'cancelled',
      reservationReleased: true,
    });
  });

  it('200 happy: optional reason passes through to use-case', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture({ cancellationReason: 'changing mind' }),
        reservationReleased: true as const,
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'changing mind' });
    await POST(req, ctx);
    expect(cancelBroadcastMock).toHaveBeenCalledTimes(1);
    const useCaseInput = (cancelBroadcastMock.mock.calls[0] as unknown[])?.[1] as {
      cancellationReason: string | null;
    };
    expect(useCaseInput?.cancellationReason).toBe('changing mind');
  });

  it('200 happy: missing body treated as empty (reason = null)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture(),
        reservationReleased: true as const,
      }),
    );
    const { POST } = await importRoute();
    // Send a request with no body at all
    const req = new NextRequest(
      `http://localhost/api/broadcasts/${VALID_ID}/cancel`,
      { method: 'POST', headers: {} },
    );
    const res = await POST(req, { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(200);
    const useCaseInput = (cancelBroadcastMock.mock.calls[0] as unknown[])?.[1] as {
      cancellationReason: string | null;
    };
    expect(useCaseInput?.cancellationReason).toBeNull();
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('401: unauthenticated request', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: unauthorisedResponse,
    });
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({});
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    expect(cancelBroadcastMock).not.toHaveBeenCalled();
  });

  it('403: wrong-role (admin/manager) hitting the member endpoint', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: forbiddenResponse,
    });
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({});
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect(cancelBroadcastMock).not.toHaveBeenCalled();
  });

  // ── Input validation (400) ────────────────────────────────────────────────

  it('400 invalid_body: cancellationReason > 500 chars fails zod max(500)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ cancellationReason: 'x'.repeat(501) });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(cancelBroadcastMock).not.toHaveBeenCalled();
  });

  // ── Path validation (404) ─────────────────────────────────────────────────

  it('404 broadcast_not_found: invalid uuid in path', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({}, 'not-a-uuid');
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_not_found');
    expect(cancelBroadcastMock).not.toHaveBeenCalled();
  });

  // ── Cross-member ownership (404, not 403 — anti-enumeration) ─────────────

  it('404: use-case returns broadcast_not_found for cross-member probe', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_not_found', broadcastId: VALID_ID }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({});
    const res = await POST(req, ctx);
    // Returns 404 — same as absent-row so no existence-leak
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_not_found');
  });

  // ── 409 state-machine errors ──────────────────────────────────────────────

  it('409 broadcast_cancel_too_late with observedStatus detail', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_cancel_too_late', observedStatus: 'sending' }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({});
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_cancel_too_late');
    expect(body.error.details.observedStatus).toBe('sending');
  });

  it('409 broadcast_concurrent_action_blocked', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_concurrent_action_blocked', observedStatus: 'cancelled' }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({});
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_concurrent_action_blocked');
  });

  // ── Server errors (500) ───────────────────────────────────────────────────

  it('500 internal_error: use-case throws unexpectedly', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    cancelBroadcastMock.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({});
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal_error');
  });

  it('500 internal_error: use-case returns cancel.server_error', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'cancel.server_error', message: 'db down' }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({});
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal_error');
  });

  // ── Observability ─────────────────────────────────────────────────────────

  it('correlation id present in success response headers', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    cancelBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture(),
        reservationReleased: true as const,
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({});
    const res = await POST(req, ctx);
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });
});
