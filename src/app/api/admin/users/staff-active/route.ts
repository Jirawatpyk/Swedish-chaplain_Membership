/**
 * F8 Phase 8 T222 — `GET /api/admin/users/staff-active`.
 *
 * Returns the list of active staff users (`role IN ('admin', 'manager')`,
 * `status = 'active'`) for use in the escalation-task reassign combobox
 * (T222). RBAC: admin+manager allowed (read).
 *
 * Tenant scoping note: the F1 `users` table is currently global (MTA
 * model — see saas-architecture.md). Multi-tenant filtering will be
 * layered when F1 ships per-tenant user assignment. For SweCham (F8 first
 * tenant) the user pool is the chamber's own staff — no cross-tenant
 * concern.
 *
 * Response: `{ users: [{ id, email, display_name, role }] }`.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import { errorResponse } from '@/lib/renewals-route-helpers';
import { requireApiPermission } from '@/lib/rbac';
import { legacyAdminOrManager } from '@/modules/auth/domain/permissions/legacy-shim';
import { userRepo } from '@/lib/auth-deps';

export async function GET(request: NextRequest) {
  // 016 T028: session + role fold into one gate (replaces the pre-sweep
  // `requireSession` NEXT_REDIRECT-filter idiom — the gate 401s JSON instead of
  // redirecting, and a session-store outage now surfaces as 500 via the gate's
  // own `rbac.session-lookup-failed` log rather than a silent 401). Denial
  // shape changes from the borrowed F8 envelope to the uniform sweep contract
  // (`{error:'no-session'|'forbidden'}`); the reassign combobox branches on
  // `res.ok` only. Key `renewals.read` per the frozen baseline — this list
  // feeds the renewals escalation UI.
  const ctx = await requireApiPermission(request, 'renewals.read', legacyAdminOrManager);
  if ('response' in ctx) return ctx.response;

  const correlationId = randomUUID();
  try {
    // R10 S6 close — Promise.all parallelizes the two role queries
    // (UserRepo.listWithFilter currently accepts a single Role only;
    // a future Phase 9 schema extension can collapse to a single
    // query when `UserListFilter.roles?: Role[]` is added). Hard cap
    // 100 per role is appropriate for SweCham; max 200 total.
    const [adminUsers, managerUsers] = await Promise.all([
      userRepo.listWithFilter({ role: 'admin', status: 'active' }, 100, 0),
      userRepo.listWithFilter({ role: 'manager', status: 'active' }, 100, 0),
    ]);
    const merged = [...adminUsers, ...managerUsers].map((u) => ({
      id: u.id,
      email: u.email,
      display_name: u.displayName ?? null,
      role: u.role,
    }));

    return NextResponse.json(
      { users: merged },
      {
        status: 200,
        headers: {
          'X-Correlation-Id': correlationId,
          'Cache-Control': 'no-store, private',
        },
      },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
      },
      'admin.users.staff-active.list_unexpected_error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId,
    });
  }
}
