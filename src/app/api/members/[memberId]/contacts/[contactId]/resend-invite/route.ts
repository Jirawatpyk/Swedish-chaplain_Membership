/**
 * Admin resend-bounced-invite endpoint — F3 spec § Edge Cases.
 *
 * Admin-only POST that re-issues a fresh invitation token + outbox row
 * for a contact whose invitation email previously bounced
 * (`contacts.invite_bounced_at` is set). Two-phase: the F1 owner-role mint
 * + outbox enqueue commit first; a separate chamber_app tx then clears the
 * bounce flag + emits the `member_portal_invite_queued` audit.
 *
 * Mirrors the `resend-verification` route in structure and error mapping.
 *
 * Response: 200 `{ invitation_id }` — the admin UI surfaces a toast
 * confirming the re-send and the bounced badge disappears on the next
 * page refresh.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  resendBouncedInvite,
  type ContactId,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requireAdminContext } from '@/lib/admin-context';
import { logger } from '@/lib/logger';

const paramsSchema = z.object({
  memberId: z.string().uuid(),
  contactId: z.string().uuid(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string; contactId: string }> },
): Promise<NextResponse> {
  const gate = await requireAdminContext(request, {
    resource: 'members',
    action: 'write',
  });
  if ('response' in gate) return gate.response;
  const { current, requestId } = gate;

  const resolved = await params;
  const parsed = paramsSchema.safeParse(resolved);
  if (!parsed.success) {
    // Same `{ error: 'not_found' }` shape the use-case errors use, so the
    // client toast handler matches on a single string discriminant.
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const { memberId, contactId } = parsed.data;
  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);

  const result = await resendBouncedInvite(
    {
      tenant,
      contactRepo: deps.contactRepo,
      userEmails: deps.userEmails,
      reissueInvitation: deps.reissueInvitation,
      audit: deps.audit,
      clock: deps.clock,
    },
    {
      contactId: contactId as ContactId,
      memberId,
      actorUserId: current.user.id,
      requestId,
      // No explicit locale — the use-case delivers in the recipient's
      // contact.preferredLanguage (EN/TH/SV).
    },
  );

  if (!result.ok) {
    switch (result.error.code) {
      case 'not_found':
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      case 'not_eligible':
        return NextResponse.json(
          { error: 'not_eligible', reason: result.error.reason },
          { status: 409 },
        );
      default:
        logger.error(
          { requestId, err: result.error },
          'members.resend_bounced_invite.server_error',
        );
        return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
  }

  return NextResponse.json(
    { invitation_id: result.value.invitationId },
    { status: 200 },
  );
}
