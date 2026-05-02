/**
 * T093 — Contract test: POST /api/admin/broadcasts/[id]/approve.
 *
 * Wave 6 GREEN. Spec authority: contracts/broadcasts-api.md § 2.3.
 *
 * Two body variants via discriminatedUnion 'decision':
 *   - { decision: 'send_now' }
 *   - { decision: 'schedule', scheduledFor: ISO8601 (≥ now+5min) }
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const approveBroadcastMock = vi.fn();
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
  approveBroadcast: (...args: unknown[]) => approveBroadcastMock(...args),
  makeApproveBroadcastDeps: () => ({}),
  parseBroadcastId: (id: string) =>
    UUID_RE.test(id)
      ? { ok: true, value: id }
      : { ok: false, error: { kind: 'invalid_uuid' } },
  tenantDefaultLocaleFor: () => 'en',
  emailTransactionalBridge: {
    sendMemberEmail: (...args: unknown[]) => sendMemberEmailMock(...args),
  },
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
  requestId: 'req-app-1',
};

function makeRequest(body: unknown, pathId = VALID_ID) {
  const req = new NextRequest(
    `http://localhost/api/admin/broadcasts/${pathId}/approve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { req, ctx: { params: Promise.resolve({ id: pathId }) } };
}

async function importRoute() {
  return import('@/app/api/admin/broadcasts/[id]/approve/route');
}

function broadcastFixture(status = 'approved', overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-06-15T05:00:00Z');
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
    status,
    submittedAt: now,
    approvedAt: now,
    approvedByUserId: 'user-admin-1',
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
    scheduledFor: now,
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => vi.clearAllMocks());

describe('POST /api/admin/broadcasts/[id]/approve — Wave 6 GREEN (T093)', () => {
  it('200 send_now: { broadcastId, status:approved, approvedAt, scheduledFor, resendBroadcastId:null }', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const now = new Date('2026-06-15T05:00:00Z');
    approveBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture(),
        status: 'approved' as const,
        approvedAt: now,
        scheduledFor: now,
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'send_now' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      broadcastId: VALID_ID,
      status: 'approved',
      resendBroadcastId: null,
    });
    expect(typeof body.approvedAt).toBe('string');
    expect(typeof body.scheduledFor).toBe('string');
  });

  it('200 schedule: scheduledFor reflects future timestamp', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    approveBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture('approved'),
        status: 'approved' as const,
        approvedAt: new Date(),
        scheduledFor: future,
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({
      decision: 'schedule',
      scheduledFor: future.toISOString(),
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scheduledFor).toBe(future.toISOString());
  });

  it('400 invalid_body: schedule without scheduledFor', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'schedule' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(approveBroadcastMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body: scheduledFor < now+5min (zod refine)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const tooSoon = new Date(Date.now() + 60 * 1000);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({
      decision: 'schedule',
      scheduledFor: tooSoon.toISOString(),
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: malformed JSON', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const req = new NextRequest(
      `http://localhost/api/admin/broadcasts/${VALID_ID}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      },
    );
    const { POST } = await importRoute();
    const res = await POST(req, {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: unknown decision discriminator', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'bogus' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('404 broadcast_not_found: invalid uuid in path', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'send_now' }, 'not-a-uuid');
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_not_found');
    expect(approveBroadcastMock).not.toHaveBeenCalled();
  });

  it('404 broadcast_not_found: use-case not_found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    approveBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_not_found', broadcastId: VALID_ID }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'send_now' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('409 broadcast_invalid_state_transition with observedStatus detail', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    approveBroadcastMock.mockResolvedValueOnce(
      err({
        kind: 'broadcast_invalid_state_transition',
        observedStatus: 'rejected',
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'send_now' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.details.observedStatus).toBe('rejected');
  });

  it('409 broadcast_concurrent_action_blocked', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    approveBroadcastMock.mockResolvedValueOnce(
      err({
        kind: 'broadcast_concurrent_action_blocked',
        observedStatus: 'cancelled',
      }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'send_now' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
  });

  it('422 broadcast_schedule_too_soon (use-case branch)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const tooSoon = new Date(Date.now() + 60_000);
    approveBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_schedule_too_soon', scheduledFor: tooSoon }),
    );
    const { POST } = await importRoute();
    const future = new Date(Date.now() + 6 * 60 * 1000); // pass zod refine; use-case rejects
    const { req, ctx } = makeRequest({
      decision: 'schedule',
      scheduledFor: future.toISOString(),
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_schedule_too_soon');
  });

  it('401 unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    });
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'send_now' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    expect(approveBroadcastMock).not.toHaveBeenCalled();
  });

  it('403 manager-role attempting approve (forbidden)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'send_now' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
  });

  it('500 internal_error: use-case throws', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    approveBroadcastMock.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'send_now' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);
  });

  it('500 internal_error: use-case returns approve.server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    approveBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'approve.server_error', message: 'db down' }),
    );
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'send_now' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(500);
  });

  it('member email failure does NOT 5xx the request (best-effort)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const now = new Date();
    approveBroadcastMock.mockResolvedValueOnce(
      ok({
        broadcast: broadcastFixture(),
        status: 'approved' as const,
        approvedAt: now,
        scheduledFor: now,
      }),
    );
    sendMemberEmailMock.mockRejectedValueOnce(new Error('resend down'));
    const { POST } = await importRoute();
    const { req, ctx } = makeRequest({ decision: 'send_now' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
  });
});
