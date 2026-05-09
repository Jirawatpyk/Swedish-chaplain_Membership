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
  let session;
  try {
    session = await requireSession('staff');
  } catch {
    return errorResponse({
      status: 401,
      code: 'unauthenticated',
      correlationId: randomUUID(),
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
    const list = await userRepo.listWithFilter(
      { role: 'admin', status: 'active' },
      100,
      0,
    );
    const managers = await userRepo.listWithFilter(
      { role: 'manager', status: 'active' },
      100,
      0,
    );

    const merged = [...list, ...managers].map((u) => ({
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
