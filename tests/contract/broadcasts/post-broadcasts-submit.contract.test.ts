/**
 * T037 — Contract test: POST /api/broadcasts/submit.
 *
 * Wave 6 GREEN. Spec authority: contracts/broadcasts-api.md § 1.3.
 *
 * Verifies wire contract for the FR-002 preconditions a–k surfaces:
 * member-context guard + zod input + use-case error → HTTP code map.
 * The 11 preconditions themselves are exhaustively tested at the
 * use-case unit level (submit-broadcast.test.ts — 32 tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const submitBroadcastMock = vi.fn();
const resolveTenantDisplayNameMock = vi.fn(
  async (..._args: unknown[]) => 'Test Chamber',
);

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/broadcasts-route-helpers', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/broadcasts-route-helpers')
  >('@/lib/broadcasts-route-helpers');
  return {
    ...actual,
    resolveTenantDisplayName: (...args: unknown[]) =>
      resolveTenantDisplayNameMock(...args),
  };
});
vi.mock('@/modules/broadcasts', () => ({
  submitBroadcast: (...args: unknown[]) => submitBroadcastMock(...args),
  makeSubmitBroadcastDeps: () => ({}),
}));

const BROADCAST_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const memberCtx = {
  current: {
    user: {
      id: 'user-member-1',
      email: 'member@swecham.test',
      role: 'member' as const,
      status: 'active' as const,
      displayName: 'Member',
    },
    session: { id: 'sess-m-1' },
  },
  tenant: { slug: 'test-tenant', __brand: true },
  member: { memberId: 'm-1', planId: 'p-1' },
  memberId: 'm-1',
  ownContact: { contactId: 'c-1' },
  ownContactId: 'c-1',
  sourceIp: '203.0.113.10',
  requestId: 'req-sub-1',
};

const VALID_BODY = {
  subject: 'My broadcast',
  bodyHtml: '<p>Hello</p>',
  bodySource: 'plain',
  segment: { kind: 'all_members' as const },
  scheduledFor: null,
};

const submitOutput = {
  broadcastId: BROADCAST_ID,
  status: 'submitted' as const,
  submittedAt: new Date('2026-06-15T05:00:00Z'),
  estimatedRecipientCount: 42,
  reservedQuotaSlot: true as const,
  reviewSlaTargetHours: 48,
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/broadcasts/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function importRoute() {
  return import('@/app/api/broadcasts/submit/route');
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => vi.clearAllMocks());

describe('POST /api/broadcasts/submit — Wave 6 GREEN (T037)', () => {
  it('200 happy: { broadcastId, status:submitted, submittedAt, estimatedRecipientCount, reviewSlaTargetHours }', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(ok(submitOutput));
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      broadcastId: BROADCAST_ID,
      status: 'submitted',
      estimatedRecipientCount: 42,
      reviewSlaTargetHours: 48,
    });
    expect(typeof body.submittedAt).toBe('string');
  });

  it('actorRole=member_self_service propagated to use-case', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(ok(submitOutput));
    const { POST } = await importRoute();
    await POST(makeRequest(VALID_BODY));
    const callArgs = submitBroadcastMock.mock.calls[0]?.[1] as {
      actorRole: string;
    };
    expect(callArgs.actorRole).toBe('member_self_service');
  });

  it('400 invalid_body: subject empty', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ ...VALID_BODY, subject: '' }));
    expect(res.status).toBe(400);
    expect(submitBroadcastMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body: subject too long', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({ ...VALID_BODY, subject: 'x'.repeat(201) }),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: bodyHtml > 200 KB', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const big = 'x'.repeat(200 * 1024 + 1);
    const res = await POST(makeRequest({ ...VALID_BODY, bodyHtml: big }));
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: tier segment without tierCodes', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({ ...VALID_BODY, segment: { kind: 'tier' } }),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: custom segment > 100 emails', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const emails = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`);
    const res = await POST(
      makeRequest({ ...VALID_BODY, segment: { kind: 'custom', emails } }),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: malformed JSON', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const req = new NextRequest('http://localhost/api/broadcasts/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const { POST } = await importRoute();
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('401: no session', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('403: non-member role attempting submit', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
  });

  it('422 broadcast_member_halted_pending_review (FR-002 precondition k)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_member_halted_pending_review', memberId: 'm-1' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_member_halted_pending_review');
  });

  it('429 broadcast_rate_limit_exceeded with Retry-After header', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_rate_limit_exceeded', retryAfterSeconds: 120 }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('120');
  });

  it('422 broadcast_not_in_plan (FR-002 precondition a)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_not_in_plan', memberId: 'm-1' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('broadcast_not_in_plan');
  });

  it('422 broadcast_quota_blocked (FR-002 precondition b)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_quota_blocked', used: 6, reserved: 0, cap: 6 }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('422 broadcast_subject_too_long (FR-002 precondition c)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_subject_too_long', maxChars: 200, actualChars: 250 }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('422 broadcast_body_too_large (FR-002 precondition d body size)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_body_too_large', bytes: 500_000 }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('422 broadcast_body_unsafe_html (FR-002 precondition e)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_body_unsafe_html', strippedTags: ['script'] }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('422 broadcast_audience_too_large (FR-002 precondition h / FR-016a 5k cap)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_audience_too_large', count: 6000 }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('422 broadcast_empty_segment_blocked (FR-002 precondition c)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_empty_segment_blocked' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('422 broadcast_custom_recipient_unknown (FR-002 precondition i / FR-015d)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({
        kind: 'broadcast_custom_recipient_unknown',
        unknownEmails: ['stranger@external.com'],
      }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('422 broadcast_member_missing_primary_contact_email (FR-002 precondition j)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({
        kind: 'broadcast_member_missing_primary_contact_email',
        memberId: 'm-1',
      }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('500 internal_error: submit.server_error', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(
      err({ kind: 'submit.server_error', message: 'db down' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
  });

  it('500 internal_error: thrown', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
  });

  it('correlation id present in success response headers', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    submitBroadcastMock.mockResolvedValueOnce(ok(submitOutput));
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });
});
