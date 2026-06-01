/**
 * Admin invite-portal endpoint — FR-012 (T046/T056).
 *
 * Admin-only POST that invites a contact to the member portal. Wraps
 * F1 `createUser` (pending user + 7-day invitation token + email) and
 * binds the new user id to the contact row via `contactRepo.linkUser`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { invitePortal, type ContactId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requireAdminContext } from '@/lib/admin-context';
import { logger } from '@/lib/logger';

const paramsSchema = z.object({
  memberId: z.string().uuid(),
  contactId: z.string().uuid(),
});

// go-live P1-17: the F1-createUser glue now lives in `createUserPortAdapter`,
// wired into `buildMembersDeps().createUser` — shared by this single-invite
// route AND the bulk-invite route so there is no parallel adapter to drift.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string; contactId: string }> },
): Promise<NextResponse> {
  const gate = await requireAdminContext(request, {
    resource: 'contacts',
    action: 'write',
  });
  if ('response' in gate) return gate.response;
  const { current, sourceIp, requestId } = gate;

  const resolved = await params;
  const parsed = paramsSchema.safeParse(resolved);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Contact not found.' } },
      { status: 404 },
    );
  }
  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);

  const result = await invitePortal(
    {
      tenant,
      contactRepo: deps.contactRepo,
      createUser: deps.createUser,
      deleteInvitedUser: deps.deleteInvitedUser,
    },
    {
      contactId: parsed.data.contactId as ContactId,
      actorUserId: current.user.id,
      sourceIp,
      requestId,
    },
  );

  if (!result.ok) {
    switch (result.error.code) {
      case 'not_found':
        return NextResponse.json(
          { error: { code: 'not_found', message: 'Contact not found.' } },
          { status: 404 },
        );
      case 'already_linked':
        return NextResponse.json(
          { error: { code: 'already_linked', message: 'Contact already has a portal account.' } },
          { status: 409 },
        );
      case 'no_email':
        return NextResponse.json(
          { error: { code: 'no_email', message: 'Contact has no email address.' } },
          { status: 400 },
        );
      case 'invalid_email':
        return NextResponse.json(
          { error: { code: 'invalid_email', message: 'Contact email is not valid.' } },
          { status: 400 },
        );
      case 'email_taken':
        return NextResponse.json(
          { error: { code: 'email_taken', message: 'Email already in use by another account.' } },
          { status: 409 },
        );
      case 'link_failed':
        // go-live #12-13 — the contact link faulted after createUser committed;
        // the invite was rolled back (SAGA compensation) so no orphan persists.
        // Surface a real 500 so the admin retries (the pre-fix code falsely
        // returned 200 + left a permanent orphan).
        logger.error(
          { requestId, contactId: parsed.data.contactId },
          'members.invite_portal.link_failed',
        );
        return NextResponse.json(
          { error: { code: 'link_failed', message: 'Could not link the portal account. Please try again.' } },
          { status: 500 },
        );
      default:
        logger.error(
          { requestId, err: result.error },
          'members.invite_portal.server_error',
        );
        return NextResponse.json(
          { error: { code: 'server_error', message: 'Internal server error.' } },
          { status: 500 },
        );
    }
  }

  return NextResponse.json(
    { user_id: result.value.userId, email: result.value.email },
    { status: 200 },
  );
}
