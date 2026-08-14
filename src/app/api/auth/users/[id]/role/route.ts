/**
 * POST /api/auth/users/[id]/role (T132, contracts/auth-api.md § 10).
 *
 * Admin-only. Changes a user's role + invalidates all their sessions.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { changeRole, asUserId, isStaffRole } from '@/modules/auth';
import { requireApiPermission } from '@/lib/rbac';
import { userRepo } from '@/lib/auth-deps';
import { logger } from '@/lib/logger';

// Every role is assignable from the users-page picker: `super_admin` in PR 3
// (T048), `marketing` in PR 4 (T059 / D17). The server enum must match the
// picker — widen all four lists together, never one (role.ts ASSIGNABLE_ROLES
// note; assignable-roles-lockstep.test.ts is the gate). The § 7.1 step-2 gate
// below still requires `users.manage` (super-admin-only on the ON leg) whenever
// the target's current OR requested role is a staff role, so only a super_admin
// can hand out `super_admin` — or `marketing`.
const inputSchema = z.object({
  newRole: z.enum(['super_admin', 'admin', 'manager', 'member', 'marketing']),
});

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
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'invalid-input', message: 'Body must be JSON' },
        { status: 400 },
      );
    }

    const parsed = inputSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid-role' }, { status: 400 });
    }

    const { id } = await params;

    // Step 2 (§ 7.1): staff-role target (current OR requested role) requires
    // `users.manage`. A missing target falls through — the use case's own
    // not-found path answers 404 exactly as pre-sweep.
    const target = await userRepo.findById(asUserId(id));
    if (
      (target && isStaffRole(target.role)) ||
      isStaffRole(parsed.data.newRole)
    ) {
      const staffGate = await requireApiPermission(
        request,
        'users.manage',
      );
      if ('response' in staffGate) return staffGate.response;
    }
    const result = await changeRole({
      targetUserId: asUserId(id),
      newRole: parsed.data.newRole,
      actorUserId: ctx.current.user.id,
      sourceIp: ctx.sourceIp,
      requestId: ctx.requestId,
    });

    if (result.ok) {
      return NextResponse.json(
        { ok: true, sessionsRevoked: result.value.sessionsRevoked },
        { status: 200 },
      );
    }

    const { error } = result;
    switch (error.code) {
      case 'not-found':
        return NextResponse.json({ error: 'not-found' }, { status: 404 });
      case 'same-role':
        return NextResponse.json({ error: 'same-role' }, { status: 409 });
      case 'role-portal-mismatch':
        return NextResponse.json(
          { error: 'role-portal-mismatch' },
          { status: 400 },
        );
      case 'last-admin-protection':
        return NextResponse.json(
          { error: 'last-admin-protection' },
          { status: 409 },
        );
      default: {
        logger.error(
          { requestId: ctx.requestId },
          'change-role: unhandled error variant',
        );
        return NextResponse.json({ error: 'server-error' }, { status: 500 });
      }
    }
  } catch (error) {
    logger.error(
      { err: error, requestId: ctx.requestId },
      'change-role.infra-error',
    );
    return NextResponse.json(
      { error: 'server-error', requestId: ctx.requestId },
      { status: 500 },
    );
  }
}
