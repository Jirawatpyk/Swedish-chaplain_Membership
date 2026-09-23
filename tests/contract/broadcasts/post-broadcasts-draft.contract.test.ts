/**
 * T036 — Contract test: POST/PUT /api/broadcasts/draft.
 *
 * Wave 6 GREEN. Spec authority: contracts/broadcasts-api.md § 1.1.
 *
 * Verifies:
 *   - zod input validation (subject, body, segment)
 *   - 201 (POST create) vs 200 (PUT update) envelope shapes
 *   - Member-context guard (401 / 403)
 *   - Use-case error → HTTP code mapping
 *
 * The handler delegates kill-switch enforcement to `src/proxy.ts` (not
 * tested here — covered in middleware tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const saveDraftMock = vi.fn();
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
vi.mock('@/modules/broadcasts', async () => {
  // The custom-list classifier runs the REAL submit-time check, so the two
  // halves it needs come through unmocked.
  const entries = await vi.importActual<
    typeof import('@/modules/broadcasts/application/use-cases/validate-custom-recipients')
  >('@/modules/broadcasts/application/use-cases/validate-custom-recipients');
  const validator = await vi.importActual<
    typeof import('@/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator')
  >('@/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator');
  return {
    saveDraft: (...args: unknown[]) => saveDraftMock(...args),
    makeSaveDraftDeps: () => ({}),
    CUSTOM_RECIPIENTS_MAX_ENTRIES: entries.CUSTOM_RECIPIENTS_MAX_ENTRIES,
    checkCustomRecipientEntries: entries.checkCustomRecipientEntries,
    rfc5321EmailValidator: validator.rfc5321EmailValidator,
  };
});

const NEW_BROADCAST_ID = '99999999-9999-9999-9999-999999999999';
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
  requestId: 'req-draft-1',
};

const VALID_BODY = {
  subject: 'My broadcast',
  bodyHtml: '<p>Hello</p>',
  bodySource: 'plain',
  segmentType: 'all_members' as const,
  segmentParams: null,
  customRecipientEmails: null,
  scheduledFor: null,
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/broadcasts/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function makePutRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/broadcasts/draft', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function importRoute() {
  return import('@/app/api/broadcasts/draft/route');
}

function broadcastFixture(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-06-15T05:00:00Z');
  return {
    tenantId: 'test-tenant',
    broadcastId: NEW_BROADCAST_ID,
    requestedByMemberId: 'm-1',
    requestedByMemberPlanIdSnapshot: 'p-1',
    submittedByUserId: 'user-member-1',
    actorRole: 'member_self_service',
    subject: VALID_BODY.subject,
    bodyHtml: VALID_BODY.bodyHtml,
    bodySource: 'plain',
    fromName: 'Test Chamber',
    replyToEmail: 'me@example.com',
    segmentType: 'all_members',
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: 0,
    status: 'draft',
    submittedAt: null,
    approvedAt: null,
    approvedByUserId: null,
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => vi.clearAllMocks());

describe('POST/PUT /api/broadcasts/draft — Wave 6 GREEN (T036)', () => {
  it('POST 201: returns { broadcastId, status:draft, createdAt, updatedAt, subject, segmentType }', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    saveDraftMock.mockResolvedValueOnce(
      ok({ broadcast: broadcastFixture(), created: true }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      broadcastId: NEW_BROADCAST_ID,
      status: 'draft',
      subject: VALID_BODY.subject,
      segmentType: 'all_members',
    });
    expect(typeof body.createdAt).toBe('string');
  });

  it('POST 400 invalid_body: unknown segmentType', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({ ...VALID_BODY, segmentType: 'random' }),
    );
    expect(res.status).toBe(400);
  });

  it('POST 422 broadcast_custom_recipient_too_many: customRecipientEmails > 100', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const emails = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`);
    const res = await POST(
      makeRequest({
        ...VALID_BODY,
        segmentType: 'custom',
        customRecipientEmails: emails,
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_custom_recipient_too_many');
    expect(body.error.details.count).toBe(101);
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('POST 400 invalid_body: malformed JSON', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const req = new NextRequest('http://localhost/api/broadcasts/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const { POST } = await importRoute();
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('POST 401: no session', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('POST 403: non-member role (admin attempting member route)', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
  });

  it('POST 422 broadcast_subject_too_long surfaced from use-case', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    saveDraftMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_subject_too_long', length: 250 }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_subject_too_long');
    expect(body.error.details.submittedLength).toBe(250);
  });

  // PUT tests
  it('PUT 200: returns { broadcastId, status:draft, updatedAt }', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    saveDraftMock.mockResolvedValueOnce(
      ok({ broadcast: broadcastFixture(), created: false }),
    );
    const { PUT } = await importRoute();
    const res = await PUT(
      makePutRequest({ ...VALID_BODY, draftId: NEW_BROADCAST_ID }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.broadcastId).toBe(NEW_BROADCAST_ID);
    expect(body.status).toBe('draft');
  });

  it('PUT 400: draftId missing', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { PUT } = await importRoute();
    const res = await PUT(makePutRequest(VALID_BODY));
    expect(res.status).toBe(400);
  });

  it('PUT 404 broadcast_not_found surfaced from use-case', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    saveDraftMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_not_found', broadcastId: NEW_BROADCAST_ID }),
    );
    const { PUT } = await importRoute();
    const res = await PUT(
      makePutRequest({ ...VALID_BODY, draftId: NEW_BROADCAST_ID }),
    );
    expect(res.status).toBe(404);
  });

  it('PUT 409 broadcast_immutable_after_submit', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    saveDraftMock.mockResolvedValueOnce(
      err({
        kind: 'broadcast_immutable_after_submit',
        broadcastId: NEW_BROADCAST_ID,
        currentStatus: 'submitted',
      }),
    );
    const { PUT } = await importRoute();
    const res = await PUT(
      makePutRequest({ ...VALID_BODY, draftId: NEW_BROADCAST_ID }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.details.currentStatus).toBe('submitted');
  });

  it('500 internal_error on use-case throw', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    saveDraftMock.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
  });

  it('500 internal_error: save_draft.server_error from use-case', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    saveDraftMock.mockResolvedValueOnce(
      err({ kind: 'save_draft.server_error', message: 'db down' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
  });

  it('correlation id present in success response', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    saveDraftMock.mockResolvedValueOnce(
      ok({ broadcast: broadcastFixture(), created: true }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });
});
/**
 * F119 security review F1-2 (2026-09-22) — the FR-041 design-block codes are
 * refused 422 on THIS route too, not only on the test copy. `validateBlocks`
 * used to run solely in `send-test-copy.ts`, so a body with four CTA buttons
 * or an undescribed banner was saved, submitted and delivered. The mapping is
 * `designBlockErrorResponse` in `broadcasts-route-helpers.ts`: the FIRST
 * violation's code as the error code, the whole list in `details.violations`.
 */

/**
 * F119 portal live walk U28 (2026-09-22) — a CORRECTABLE refusal must carry
 * the code the locales already translate, not the generic `invalid_body`.
 *
 * Measured live: body typed, subject empty, `Save as draft` → 400
 * `invalid_body` → `portal.broadcasts.compose.errors` has no `invalid_body`
 * key in en, th or sv → `compose-form.tsx`'s `t.has()` falls through to
 * `internal_error`, so the member read "An unexpected error occurred. Please
 * try again." for a refusal a retry can never fix. The right copy already
 * existed and was unreachable: `broadcast_subject_empty` /
 * `broadcast_subject_too_long` were only ever emitted by `submit/route.ts`,
 * and Submit is disabled in exactly the state that produces them.
 *
 * Save-as-draft and Submit now refuse the same input with the same code — and
 * therefore the same words — while a genuinely malformed body (unknown segment
 * kind, missing `draftId` on PUT, non-JSON) keeps a truthful `invalid_body`.
 */
describe('POST /api/broadcasts/draft — U28 correctable refusals name the field', () => {
  it('POST 422 broadcast_subject_empty: subject empty', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ ...VALID_BODY, subject: '' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('broadcast_subject_empty');
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('POST 422 broadcast_subject_too_long: subject > 200 chars', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({ ...VALID_BODY, subject: 'x'.repeat(201) }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_subject_too_long');
    expect(body.error.details.submittedLength).toBe(201);
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('POST 422 broadcast_body_too_large: bodyHtml > 200 KB', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const big = 'x'.repeat(200 * 1024 + 1);
    const res = await POST(makeRequest({ ...VALID_BODY, bodyHtml: big }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_body_too_large');
    expect(body.error.details.submittedSize).toBe(200 * 1024 + 1);
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('PUT 422 broadcast_subject_empty: the update path refuses identically', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { PUT } = await importRoute();
    const res = await PUT(
      makePutRequest({ ...VALID_BODY, subject: '', draftId: NEW_BROADCAST_ID }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('broadcast_subject_empty');
  });

  // The custom list is refused with the codes `validateCustomRecipients` —
  // the submit-time check — produces, and with the same details, so the
  // form puts the same words on the same field whichever button was pressed.
  it('POST 422 broadcast_custom_recipient_invalid_format: names the entries that failed', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        ...VALID_BODY,
        segmentType: 'custom',
        customRecipientEmails: ['ok@example.com', 'not-an-email'],
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_custom_recipient_invalid_format');
    expect(body.error.details.invalid).toEqual(['not-an-email']);
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('PUT 422: the update path refuses the custom list identically', async () => {
    requireMemberContextMock
      .mockResolvedValueOnce(memberCtx)
      .mockResolvedValueOnce(memberCtx);
    const { PUT } = await importRoute();
    const invalid = await PUT(
      makePutRequest({
        ...VALID_BODY,
        draftId: NEW_BROADCAST_ID,
        segmentType: 'custom',
        customRecipientEmails: ['not-an-email'],
      }),
    );
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error.code).toBe(
      'broadcast_custom_recipient_invalid_format',
    );

    const tooMany = await PUT(
      makePutRequest({
        ...VALID_BODY,
        draftId: NEW_BROADCAST_ID,
        segmentType: 'custom',
        customRecipientEmails: Array.from({ length: 101 }, (_, i) => `u${i}@example.com`),
      }),
    );
    expect(tooMany.status).toBe(422);
    expect((await tooMany.json()).error.code).toBe('broadcast_custom_recipient_too_many');
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('a custom list that is malformed rather than correctable keeps invalid_body', async () => {
    requireMemberContextMock
      .mockResolvedValueOnce(memberCtx)
      .mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    // A non-string entry is a shape error, not an address the member mistyped.
    const nonString = await POST(
      makeRequest({ ...VALID_BODY, segmentType: 'custom', customRecipientEmails: [42] }),
    );
    expect(nonString.status).toBe(400);
    expect((await nonString.json()).error.code).toBe('invalid_body');

    // A valid list beside an unrelated shape error does not borrow a list code.
    const validList = await POST(
      makeRequest({
        ...VALID_BODY,
        segmentType: 'random',
        customRecipientEmails: ['ok@example.com'],
      }),
    );
    expect(validList.status).toBe(400);
    expect((await validList.json()).error.code).toBe('invalid_body');
  });

  it('a body that is malformed rather than correctable keeps invalid_body', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({ ...VALID_BODY, segmentType: 'random' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });
});

describe('POST /api/broadcasts/draft — F119 FR-041 design-block rules', () => {
  it('422 content_rules → the first violation code + details.violations', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    saveDraftMock.mockResolvedValueOnce(
      err({
        kind: 'content_rules' as const,
        violations: [
        { code: 'too_many_cta' as const, index: 3, max: 3 as const },
        { code: 'banner_alt_required' as const, index: 4, min: 1 as const, max: 125 as const },
      ],
      }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('too_many_cta');
    expect(body.error.details.violations).toHaveLength(2);
    expect(body.error.messageThai).toBeTruthy();
  });
});
