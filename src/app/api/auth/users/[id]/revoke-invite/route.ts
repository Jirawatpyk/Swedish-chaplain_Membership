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
import { revokeInvitation, asUserId, isStaffRole } from '@/modules/auth';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { userRepo } from '@/lib/auth-deps';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // 016 T028 (§ 7.1 per-TARGET contract): step 1 gates on the wider
  // `users.member_accounts`; step 2 below re-gates on `users.manage` (SA-only
  // on the ON leg) when the TARGET is a staff row. Both OFF-leg rows are the
  // pre-sweep `requireAdminContext(request)` policy — byte-identical.
  const ctx = await requireApiPermission(
    request,
    'users.member_accounts',
  );
  if ('response' in ctx) return ctx.response;
  // B3 — outer try/catch (see sign-in/route.ts B3 note).
  try {
    const { id } = await params;
    const tenant = resolveTenantFromRequest(request);

    // Step 2 (§ 7.1): staff-role target requires `users.manage`. A missing
    // target falls through — the use case answers 404 exactly as pre-sweep.
    const target = await userRepo.findById(asUserId(id));
    if (target && isStaffRole(target.role)) {
      const staffGate = await requireApiPermission(
        request,
        'users.manage',
      );
      if ('response' in staffGate) return staffGate.response;
    }

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
