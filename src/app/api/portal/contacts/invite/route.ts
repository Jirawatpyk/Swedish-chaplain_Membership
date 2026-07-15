/**
 * Portal colleague invite API — POST (T121).
 *
 * POST /api/portal/contacts/invite — primary-contact-only (FR-015)
 *
 * RBAC: `member` role only, primary contact gating enforced by
 * the `invite-colleague` use case.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireMemberContext } from '@/lib/member-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  inviteColleague,
  inviteColleagueSchema,
  type CreateUserPort,
} from '@/modules/members';
import { parseIdempotencyKey } from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import { createUser as f1CreateUser } from '@/modules/auth';

export async function POST(request: NextRequest) {
  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  // Idempotency-Key required — format validation only. Full
  // classify/reserve/remember flow is intentionally deferred to F9
  // (idempotency layer). Domain-level duplicate protection: inviting
  // the same email twice hits the `email-taken` branch of
  // `invitePortal` → returns 409 without creating a second invitation.
  // Tracked: F9 idempotency layer.
  const idemResult = parseIdempotencyKey(request.headers);
  if (!idemResult.ok) {
    return NextResponse.json(
      { error: { code: 'missing_idempotency_key', message: 'Idempotency-Key header required' } },
      { status: 400 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Invalid JSON' } },
      { status: 400 },
    );
  }

  // Validate body
  const parsed = inviteColleagueSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'validation_error', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const deps = buildMembersDeps(ctx.tenant);

  // Wrap F1 createUser to match the narrowed CreateUserPort signature
  const createUserPort: CreateUserPort = async (input) => {
    const result = await f1CreateUser({
      ...input,
      actorUserId: input.actorUserId as Parameters<typeof f1CreateUser>[0]['actorUserId'],
    });
    if (!result.ok) {
      return { ok: false as const, error: { code: result.error.code as 'invalid-input' | 'email-taken' } };
    }
    // outboxRowId required by CreateUserPort for SAGA compensation (go-live
    // #12-13 + follow-up). inviteColleague NOW compensates: on a second-tx
    // failure the orphaned pending user is rolled back via deleteInvitedUser
    // (wired below) — see invite-colleague.ts catch block.
    return {
      ok: true as const,
      value: { user: { id: result.value.user.id }, outboxRowId: result.value.outboxRowId },
    };
  };

  const result = await inviteColleague(
    {
      tenant: ctx.tenant,
      contactRepo: deps.contactRepo,
      audit: deps.audit,
      createUser: createUserPort,
      deleteInvitedUser: deps.deleteInvitedUser,
      membershipAccess: deps.membershipAccess,
      idFactory: deps.idFactory,
    },
    {
      memberId: ctx.memberId,
      actorUserId: ctx.current.user.id,
      actorContactId: ctx.ownContactId,
      sourceIp: ctx.sourceIp,
      requestId: ctx.requestId,
      body: parsed.data,
    },
  );

  if (!result.ok) {
    switch (result.error.type) {
      case 'not_primary':
        return NextResponse.json(
          { error: { code: 'forbidden', message: result.error.reason } },
          { status: 403 },
        );
      case 'membership_suspended':
        // 059-membership-suspension Task 6 — a suspended/terminated member
        // cannot invite colleagues (each invite mints a new F1 account).
        // Enforced inside the use case (see invite-colleague.ts); this is
        // just the HTTP mapping.
        return NextResponse.json(
          {
            error: {
              code: 'membership_suspended',
              message: 'Membership is suspended or terminated',
            },
          },
          { status: 403 },
        );
      case 'email_taken':
        return NextResponse.json(
          { error: { code: 'email_taken', message: 'Email already registered' } },
          { status: 409 },
        );
      case 'invalid_email':
        return NextResponse.json(
          { error: { code: 'invalid_email', message: 'Invalid email address' } },
          { status: 400 },
        );
      case 'validation_error':
        return NextResponse.json(
          { error: { code: 'validation_error', details: result.error.issues } },
          { status: 400 },
        );
      case 'link_failed':
        // go-live #12-13 (follow-up) — the contact link faulted after createUser
        // committed; the orphaned invite was rolled back (SAGA compensation), so
        // a retry is safe. 500 (transient) with a distinct code the form maps to
        // a retry-safe toast.
        logger.error(
          { requestId: ctx.requestId },
          'portal.contacts.invite.link_failed',
        );
        return NextResponse.json(
          { error: { code: 'link_failed' } },
          { status: 500 },
        );
      default:
        logger.error(
          { error: result.error, requestId: ctx.requestId },
          'portal.contacts.invite.error',
        );
        return NextResponse.json(
          { error: { code: 'internal' } },
          { status: 500 },
        );
    }
  }

  return NextResponse.json(
    {
      contact_id: result.value.contact.contactId,
      user_id: result.value.userId,
    },
    { status: 201 },
  );
}
