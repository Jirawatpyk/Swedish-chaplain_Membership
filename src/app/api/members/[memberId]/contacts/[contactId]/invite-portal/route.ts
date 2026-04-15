/**
 * Admin invite-portal endpoint — FR-012 (T046/T056).
 *
 * Admin-only POST that invites a contact to the member portal. Wraps
 * F1 `createUser` (pending user + 7-day invitation token + email) and
 * binds the new user id to the contact row via `contactRepo.linkUser`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  invitePortal,
  type ContactId,
  type CreateUserPort,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requireAdminContext } from '@/lib/admin-context';
import { logger } from '@/lib/logger';
import { createUser as f1CreateUser } from '@/modules/auth';

// Adapt F1 createUser to the narrowed port the use case expects. The
// port constrains `role` to `'member'` so admins cannot accidentally
// invite staff via this endpoint.
const createUserPort: CreateUserPort = async (input) => {
  const result = await f1CreateUser({
    email: input.email,
    role: input.role,
    displayName: input.displayName ?? null,
    // F1 createUser takes a branded UserId; at the boundary we pass the
    // raw session user id through. Safe because F1 itself re-brands.
    actorUserId: input.actorUserId as never,
    sourceIp: input.sourceIp,
    requestId: input.requestId,
    locale: input.locale,
  });
  if (result.ok) {
    return { ok: true, value: { user: { id: result.value.user.id } } };
  }
  return { ok: false, error: { code: result.error.code } };
};

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

  const { contactId } = await params;
  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);

  const result = await invitePortal(
    { tenant, contactRepo: deps.contactRepo, createUser: createUserPort },
    {
      contactId: contactId as ContactId,
      actorUserId: current.user.id,
      sourceIp,
      requestId,
    },
  );

  if (!result.ok) {
    switch (result.error.code) {
      case 'not_found':
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      case 'already_linked':
        return NextResponse.json(
          { error: 'already_linked' },
          { status: 409 },
        );
      case 'no_email':
        return NextResponse.json({ error: 'no_email' }, { status: 400 });
      case 'invalid_email':
        return NextResponse.json(
          { error: 'invalid_email' },
          { status: 400 },
        );
      case 'email_taken':
        return NextResponse.json({ error: 'email_taken' }, { status: 409 });
      default:
        logger.error(
          { requestId, err: result.error },
          'members.invite_portal.server_error',
        );
        return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
  }

  return NextResponse.json(
    { user_id: result.value.userId, email: result.value.email },
    { status: 200 },
  );
}
