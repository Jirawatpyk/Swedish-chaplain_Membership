/**
 * F119 T145 (US6-AS5, FR-039) — `POST | PUT /api/admin/broadcasts/draft`.
 *
 * The staff compose-on-behalf DRAFT route. FR-039 requires the staff writing
 * tool to offer what the member's offers, and three of those items (draft
 * save/resume, inline images, the member's allowance) need a staff-owned
 * `draft` broadcast that nothing in PR-1 could mint: `proxy-submit` creates a
 * SUBMITTED row, and `/api/broadcasts/draft` is `requireMemberContext`-gated.
 * This route closes that gap by reusing `saveDraft`, which already takes a
 * `memberId` and `actorRole: 'admin_proxy'` — no use-case change.
 *
 * Wire contract, use case mocked at the barrel (`saveDraft` has its own unit +
 * integration suites):
 *   - `broadcasts.write` named on the gate — saving a draft is NOT sending, so
 *     it must not borrow `proxy-submit`'s `broadcasts.send`;
 *   - POST creates for the NAMED member as `admin_proxy`, stamping the staff
 *     user as `submittedByUserId` and the member's plan as the snapshot;
 *   - PUT updates; a non-`draft` row → 409 (the member route's mapping);
 *   - an unknown member of the tenant → 404, never a leak of what exists;
 *     a malformed body → 400 before any lookup;
 *   - the staff 30 / 60 s write bucket is consumed ABOVE the member read and
 *     the save, so a refused call writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { err, ok } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const saveDraftMock = vi.fn();
const checkLimitMock = vi.fn();
const findByIdMock = vi.fn();
const findErasedAtByIdMock = vi.fn();
const resolveTenantDisplayNameMock = vi.fn(async (..._args: unknown[]) => 'Test Chamber');

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/broadcasts-route-helpers', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/broadcasts-route-helpers')>(
      '@/lib/broadcasts-route-helpers',
    );
  return {
    ...actual,
    resolveTenantDisplayName: (...args: unknown[]) => resolveTenantDisplayNameMock(...args),
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
    broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
    CUSTOM_RECIPIENTS_MAX_ENTRIES: entries.CUSTOM_RECIPIENTS_MAX_ENTRIES,
    checkCustomRecipientEntries: entries.checkCustomRecipientEntries,
    rfc5321EmailValidator: validator.rfc5321EmailValidator,
  };
});
vi.mock('@/modules/members', () => ({
  drizzleMemberRepo: {
    findById: (...args: unknown[]) => findByIdMock(...args),
    findErasedAtById: (...args: unknown[]) => findErasedAtByIdMock(...args),
  },
  asMemberId: (id: string) => id,
}));

const MEMBER_ID = '22222222-2222-2222-2222-222222222222';
const DRAFT_ID = '99999999-9999-9999-9999-999999999999';

const staffCtx = {
  current: {
    user: {
      id: 'user-mk-1',
      email: 'mk@swecham.test',
      role: 'marketing' as const,
      status: 'active' as const,
      displayName: 'Mk',
    },
    session: { id: 'sess-1' },
  },
  requestId: 'req-proxy-draft-1',
};

const VALID_BODY = {
  memberId: MEMBER_ID,
  subject: 'Spring mixer',
  bodyHtml: '<p>Hello</p>',
  bodySource: '<p>Hello</p>',
  segmentType: 'all_members' as const,
  segmentParams: null,
  customRecipientEmails: null,
  scheduledFor: null,
};

function req(body: unknown, method: 'POST' | 'PUT' = 'POST'): NextRequest {
  return new NextRequest('http://localhost/api/admin/broadcasts/draft', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function draftResult(created: boolean) {
  return ok({
    created,
    broadcast: {
      broadcastId: DRAFT_ID,
      status: 'draft',
      createdAt: new Date('2026-09-18T03:00:00.000Z'),
      updatedAt: new Date('2026-09-18T03:05:00.000Z'),
      subject: 'Spring mixer',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      scheduledFor: null,
    },
  });
}

const importRoute = () => import('@/app/api/admin/broadcasts/draft/route');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  requireApiPermissionMock.mockResolvedValue(staffCtx);
  checkLimitMock.mockResolvedValue(ok(true));
  findByIdMock.mockResolvedValue(
    ok({ memberId: MEMBER_ID, companyName: 'Acme Co', planId: 'plan-1' }),
  );
  findErasedAtByIdMock.mockResolvedValue(ok({ erasedAt: null }));
  saveDraftMock.mockResolvedValue(draftResult(true));
});
afterEach(() => vi.clearAllMocks());

describe('POST | PUT /api/admin/broadcasts/draft', () => {
  it('POST creates a draft for the named member as admin_proxy (201 with the new draft id)', async () => {
    const { POST } = await importRoute();
    const res = await POST(req(VALID_BODY));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ broadcastId: DRAFT_ID, status: 'draft' });
    // Saving a draft is not sending — the gate must name `broadcasts.write`,
    // not `proxy-submit`'s `broadcasts.send`.
    expect(requireApiPermissionMock.mock.calls[0]![1]).toBe('broadcasts.write');

    const [, input] = saveDraftMock.mock.calls[0]!;
    expect(input).toMatchObject({
      memberId: MEMBER_ID,
      actorRole: 'admin_proxy',
      submittedByUserId: 'user-mk-1',
      memberPlanIdSnapshot: 'plan-1',
      memberDisplayName: 'Acme Co',
      tenantDisplayName: 'Test Chamber',
    });
    expect(input).not.toHaveProperty('draftId');
  });

  it('PUT updates the named draft (200); a row that is no longer a draft → 409', async () => {
    const { PUT } = await importRoute();
    saveDraftMock.mockResolvedValueOnce(draftResult(false));
    const okRes = await PUT(req({ ...VALID_BODY, draftId: DRAFT_ID }, 'PUT'));
    expect(okRes.status).toBe(200);
    expect(saveDraftMock.mock.calls[0]![1]).toMatchObject({ draftId: DRAFT_ID });

    saveDraftMock.mockResolvedValueOnce(
      err({
        kind: 'broadcast_immutable_after_submit',
        broadcastId: DRAFT_ID,
        currentStatus: 'submitted',
      }),
    );
    const conflict = await PUT(req({ ...VALID_BODY, draftId: DRAFT_ID }, 'PUT'));
    expect(conflict.status).toBe(409);

    // A PUT with no draftId is a shape error, not a silent create.
    const noId = await PUT(req(VALID_BODY, 'PUT'));
    expect(noId.status).toBe(400);
  });

  it('an unknown member of the tenant → 404 and nothing saved; a malformed body → 400 before any lookup', async () => {
    const { POST } = await importRoute();

    findByIdMock.mockResolvedValueOnce(err({ code: 'repo.not_found' }));
    const missing = await POST(req(VALID_BODY));
    expect(missing.status).toBe(404);
    expect(saveDraftMock).not.toHaveBeenCalled();

    const malformed = await POST(req({ ...VALID_BODY, memberId: 'not-a-uuid' }));
    expect(malformed.status).toBe(400);
    expect(findByIdMock).toHaveBeenCalledTimes(1);

    const noMember = await POST(req({ ...VALID_BODY, memberId: undefined }));
    expect(noMember.status).toBe(400);
  });

  it("a manager's 403 is returned untouched; marketing gets its 201", async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'permission_denied' }, { status: 403 }),
    });
    const { POST } = await importRoute();
    expect((await POST(req(VALID_BODY))).status).toBe(403);
    expect(saveDraftMock).not.toHaveBeenCalled();

    // `staffCtx` is a marketing user — the default arm.
    expect((await POST(req(VALID_BODY))).status).toBe(201);
  });

  it('the 31st call in a minute → 429 with Retry-After, and nothing is read or written', async () => {
    checkLimitMock.mockResolvedValueOnce(err({ retryAfterSeconds: 42 }));
    const { POST } = await importRoute();
    const res = await POST(req(VALID_BODY));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect((await res.json()).error.code).toBe('broadcast_rate_limit_exceeded');
    expect(checkLimitMock.mock.calls[0]![0]).toBe(
      'broadcasts:staff-write:test-tenant:user-mk-1',
    );
    expect(findByIdMock).not.toHaveBeenCalled();
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('an erased member is refused 409 — a staff draft must not resurrect a scrubbed company name', async () => {
    findErasedAtByIdMock.mockResolvedValueOnce(
      ok({ erasedAt: new Date('2026-08-01T00:00:00.000Z') }),
    );
    const { POST } = await importRoute();
    const res = await POST(req(VALID_BODY));

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('broadcast_member_erased');
    expect(saveDraftMock).not.toHaveBeenCalled();
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

describe('POST /api/admin/broadcasts/draft — F119 FR-041 design-block rules', () => {
  it('422 content_rules → the same envelope the member draft route returns (FR-039)', async () => {
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
    const res = await POST(req(VALID_BODY));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('too_many_cta');
    expect(body.error.details.violations).toHaveLength(2);
  });
});

/**
 * Portal live walk U28 (FR-039) — the staff draft route refuses a correctable
 * body with the SAME codes the member draft route does, because the two forms
 * share one error copy and one draft-save helper. The refusal lands before the
 * rate-limit bucket and the member read, so nothing is read or stored.
 */
describe('POST | PUT /api/admin/broadcasts/draft — U28 correctable refusals name the field', () => {
  it('POST 422 broadcast_subject_empty: subject empty, nothing read or saved', async () => {
    const { POST } = await importRoute();
    const res = await POST(req({ ...VALID_BODY, subject: '' }));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('broadcast_subject_empty');
    expect(findByIdMock).not.toHaveBeenCalled();
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('PUT 422 broadcast_subject_empty: the update path refuses identically', async () => {
    const { PUT } = await importRoute();
    const res = await PUT(req({ ...VALID_BODY, subject: '', draftId: DRAFT_ID }, 'PUT'));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('broadcast_subject_empty');
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('POST 422 broadcast_subject_too_long: subject > 200 chars, with its length', async () => {
    const { POST } = await importRoute();
    const res = await POST(req({ ...VALID_BODY, subject: 'x'.repeat(201) }));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_subject_too_long');
    expect(body.error.details.submittedLength).toBe(201);
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('POST 422 broadcast_custom_recipient_invalid_format: names the entries that failed', async () => {
    const { POST } = await importRoute();
    const res = await POST(
      req({
        ...VALID_BODY,
        segmentType: 'custom',
        customRecipientEmails: ['ok@example.com', 'not-an-email'],
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_custom_recipient_invalid_format');
    expect(body.error.details.invalid).toEqual(['not-an-email']);
    expect(findByIdMock).not.toHaveBeenCalled();
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('POST and PUT 422 broadcast_custom_recipient_too_many: 101 entries, with the count', async () => {
    const { POST, PUT } = await importRoute();
    const emails = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`);

    const created = await POST(
      req({ ...VALID_BODY, segmentType: 'custom', customRecipientEmails: emails }),
    );
    expect(created.status).toBe(422);
    const body = await created.json();
    expect(body.error.code).toBe('broadcast_custom_recipient_too_many');
    expect(body.error.details.count).toBe(101);

    const updated = await PUT(
      req(
        {
          ...VALID_BODY,
          draftId: DRAFT_ID,
          segmentType: 'custom',
          customRecipientEmails: ['not-an-email'],
        },
        'PUT',
      ),
    );
    expect(updated.status).toBe(422);
    expect((await updated.json()).error.code).toBe(
      'broadcast_custom_recipient_invalid_format',
    );
    expect(saveDraftMock).not.toHaveBeenCalled();
  });
});
