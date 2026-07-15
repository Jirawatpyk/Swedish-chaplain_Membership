/**
 * Member route boilerplate helper (US5 — T120).
 *
 * Equivalent of `admin-context.ts` but for the member self-service
 * portal. Resolves:
 *   1. Active session with `role = 'member'`
 *   2. The member record linked to the session user via
 *      `contacts.linked_user_id`
 *   3. The caller's own contact record (the contact linked to the session user)
 *
 * Returns either a `MemberContext` with all the resolved state, or
 * a `{ response }` wrapping a 401/403/404/500 NextResponse.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { CurrentSession } from '@/lib/auth-session';
import { getCurrentSession } from '@/lib/auth-session';
import { getClientIp } from '@/lib/client-ip';
import { logger } from '@/lib/logger';
import { errKind, hashId, rootCause } from '@/lib/log-id';
import { checkPortalAccess } from '@/lib/lapsed-portal-scope';
import { buildPortalAccessDeps, toPortalAccessAction } from '@/lib/portal-access-deps';
import { requestIdFromHeaders } from '@/lib/request-id';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import type { Member, MemberId } from '@/modules/members/domain/member';
import type { Contact, ContactId } from '@/modules/members/domain/contact';
import type { TenantContext } from '@/modules/tenants';

export interface MemberContext {
  readonly response?: never;
  readonly current: CurrentSession;
  readonly tenant: TenantContext;
  readonly member: Member;
  readonly memberId: MemberId;
  /** The caller's own contact — NOT necessarily the member's primary contact. */
  readonly ownContact: Contact;
  readonly ownContactId: ContactId;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface MemberContextRejection {
  readonly response: NextResponse;
}

/**
 * Load + authorise the current session for a member-only portal route.
 * Resolves the member linked to the session user via contacts.linked_user_id.
 */
export async function requireMemberContext(
  request: NextRequest,
): Promise<MemberContext | MemberContextRejection> {
  const requestId = requestIdFromHeaders(request.headers);
  const sourceIp = getClientIp(request);

  try {
    const current = await getCurrentSession();
    if (!current) {
      return {
        response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
      };
    }

    if (current.user.role !== 'member') {
      return {
        response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
      };
    }

    const tenant = resolveTenantFromRequest(request);
    const deps = buildMembersDeps(tenant);

    // Resolve the member linked to this user
    const memberResult = await deps.memberRepo.findByLinkedUserId(
      tenant,
      current.user.id,
    );
    if (!memberResult.ok) {
      // Distinguish a benign "member-role user with no linked member" (404) from
      // a DB/RLS fault (500). Conflating them masked a transient DB outage as a
      // 404 across every member route that uses this helper (review-run R2).
      // Hash the user id in logs (CLAUDE.md — never log a raw user id).
      if (memberResult.error.code !== 'repo.not_found') {
        logger.error(
          {
            requestId,
            userIdHash: hashId(current.user.id),
            errKind: errKind(rootCause(memberResult.error)),
          },
          'member-context: member lookup failed (DB fault)',
        );
        return {
          response: NextResponse.json(
            { error: { code: 'internal', message: 'Internal server error.' } },
            { status: 500 },
          ),
        };
      }
      // not_found — member-role user with no linked member (data inconsistency).
      logger.warn(
        { userIdHash: hashId(current.user.id), requestId },
        'member-context: member role user has no linked member',
      );
      return {
        response: NextResponse.json(
          { error: { code: 'not_found', message: 'No linked member found' } },
          { status: 404 },
        ),
      };
    }

    const member = memberResult.value;

    // Task 7 (059-membership-suspension) — the ALWAYS-ON terminated /
    // suspended portal-scope gate. Every `/api/portal/**` route that
    // resolves its member via `requireMemberContext` gets `checkPortalAccess`
    // enforcement on every request — unlike the SSR-only
    // `enforcePortalPageAccess` layout guard, which does not re-run on
    // client-side navigation between sibling routes, this runs on every
    // data fetch/mutation regardless of how the client got there. Checked
    // BEFORE the contacts lookup below so a blocked request short-circuits
    // without the extra round-trip. `new URL(request.url).pathname` (not
    // `request.nextUrl.pathname`) per the Task 3 controller note — the
    // normalized literal request path.
    const actionValue = toPortalAccessAction(request.method);
    const accessDecision = await checkPortalAccess(buildPortalAccessDeps(tenant), {
      tenantId: tenant.slug,
      memberId: member.memberId,
      pathname: new URL(request.url).pathname,
      actorUserId: current.user.id,
      correlationId: requestId,
      requestId,
      ...(actionValue ? { action: actionValue } : {}),
    });
    if (!accessDecision.allowed) {
      return {
        response: NextResponse.json(
          {
            error: {
              code: 'membership_access_restricted',
              message: 'Membership access is restricted for this route.',
            },
          },
          { status: 403 },
        ),
      };
    }

    // Load contacts to find the primary
    const contactsResult = await deps.contactRepo.listByMember(
      tenant,
      member.memberId,
    );
    if (!contactsResult.ok) {
      return {
        response: NextResponse.json(
          { error: 'server-error' },
          { status: 500 },
        ),
      };
    }

    // Find the caller's own contact (linked to their user)
    const ownContact = contactsResult.value.find(
      (c) => String(c.linkedUserId) === current.user.id,
    );
    if (!ownContact) {
      return {
        response: NextResponse.json(
          { error: { code: 'not_found', message: 'Contact not linked' } },
          { status: 404 },
        ),
      };
    }

    return {
      current,
      tenant,
      member,
      memberId: member.memberId,
      ownContact,
      ownContactId: ownContact.contactId,
      sourceIp,
      requestId,
    };
  } catch (error) {
    logger.error(
      { err: error, requestId },
      'member-context.infrastructure-error',
    );
    return {
      response: NextResponse.json(
        { error: 'server-error' },
        { status: 500 },
      ),
    };
  }
}
