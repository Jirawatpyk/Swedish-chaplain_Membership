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
import { requireSession } from '@/lib/auth-session';
import { userRepo } from '@/lib/auth-deps';

export async function GET(_request: NextRequest) {
  // Round 5 I-4 close — bind + log the catch so DB-down / Upstash-quota /
  // session-store outages produce a Sentry signal instead of every
  // request silently returning 401 (indistinguishable from a real
  // unauthenticated state).
  //
  // R6 IMP-2 close — `requireSession` calls `redirect()` for any
  // request without a valid session, which throws `NEXT_REDIRECT`.
  // Logging every such throw at ERROR severity floods Sentry with
  // routine anonymous traffic. Filter it out — only genuine errors
  // (DB outage, Upstash quota) reach the log call.
  let session;
  const sessionCorrelationId = randomUUID();
  try {
    session = await requireSession('staff');
  } catch (e) {
    const isNextRedirect =
      e !== null &&
      typeof e === 'object' &&
      'digest' in e &&
      typeof (e as { digest?: unknown }).digest === 'string' &&
      (e as { digest: string }).digest.startsWith('NEXT_REDIRECT');
    if (!isNextRedirect) {
      logger.error(
        {
          err: e instanceof Error ? e : new Error(String(e)),
          correlationId: sessionCorrelationId,
        },
        'admin.users.staff-active.session_resolution_failed',
      );
    }
    return errorResponse({
      status: 401,
      code: 'unauthenticated',
      correlationId: sessionCorrelationId,
    });
  }
  if (session.user.role !== 'admin' && session.user.role !== 'manager') {
    return errorResponse({
      status: 403,
      code: 'forbidden',
      correlationId: randomUUID(),
    });
  }

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
