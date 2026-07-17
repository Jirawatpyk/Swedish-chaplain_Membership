/**
 * POST /api/auth/users/[id]/revoke-invite (Staff Invitation Lifecycle, Task 4).
 *
 * Admin-only. Exposes Task 3's `revokeInvitation` use case: permanently
 * deletes a `pending` invited user (typo'd / wrong invite) and frees the
 * email for a fresh invite. DELETE-semantics on the auth surface, so
 * RBAC + tenant-scoping correctness are the priority — the use case itself
 * scopes the outbox cleanup to the caller's tenant (see
 * revoke-invitation.ts RA-3). No rate limiting: this route does not send
 * email.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { revokeInvitation, asUserId } from '@/modules/auth';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request);
  if ('response' in ctx) return ctx.response;
  // B3 — outer try/catch (see sign-in/route.ts B3 note).
  try {
    const { id } = await params;
    const tenant = resolveTenantFromRequest(request);

    const result = await revokeInvitation({
      userId: asUserId(id),
      actorUserId: ctx.current.user.id,
      tenantId: tenant.slug,
      sourceIp: ctx.sourceIp,
      requestId: ctx.requestId,
    });

    if (result.ok) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const { error } = result;
    switch (error.code) {
      case 'not-pending-or-not-found':
        return NextResponse.json({ error: 'not-pending-or-not-found' }, { status: 404 });
      default: {
        logger.error(
          { requestId: ctx.requestId },
          'revoke-invite: unhandled error variant',
        );
        return NextResponse.json({ error: 'server-error' }, { status: 500 });
      }
    }
  } catch (error) {
    logger.error(
      { err: error, requestId: ctx.requestId },
      'revoke-invite.infra-error',
    );
    return NextResponse.json(
      { error: 'server-error', requestId: ctx.requestId },
      { status: 500 },
    );
  }
}
