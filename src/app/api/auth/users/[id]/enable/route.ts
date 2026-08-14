/**
 * POST /api/auth/users/[id]/enable (T131, contracts/auth-api.md § 9).
 *
 * Admin-only. Transitions disabled → active.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { enableUser, asUserId, isStaffRole } from '@/modules/auth';
import { requireApiPermission } from '@/lib/rbac';
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
    const result = await enableUser({
      targetUserId: asUserId(id),
      actorUserId: ctx.current.user.id,
      sourceIp: ctx.sourceIp,
      requestId: ctx.requestId,
    });

    if (result.ok) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const { error } = result;
    switch (error.code) {
      case 'not-found':
        return NextResponse.json({ error: 'not-found' }, { status: 404 });
      case 'not-disabled':
        return NextResponse.json({ error: 'not-disabled' }, { status: 409 });
      default: {
        logger.error(
          { requestId: ctx.requestId },
          'enable-user: unhandled error variant',
        );
        return NextResponse.json({ error: 'server-error' }, { status: 500 });
      }
    }
  } catch (error) {
    logger.error(
      { err: error, requestId: ctx.requestId },
      'enable-user.infra-error',
    );
    return NextResponse.json(
      { error: 'server-error', requestId: ctx.requestId },
      { status: 500 },
    );
  }
}
