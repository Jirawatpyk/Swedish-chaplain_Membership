/**
 * F114 US6 (FR-033, FR-039; research R12) — the pending-change-request
 * summary for the two "at a glance" staff surfaces: the nav badge (staff
 * layout) and the dashboard "Needs attention" item. One indexed
 * `count(*) / min(submitted_at)` query per render (R12 accepts that; no cache).
 *
 * Both callers render on every staff page, so this read must never take a
 * page down: every failure — a `Result` error or a throw — degrades to
 * `null` (no badge, no item) and is logged ONCE under the CALLER's
 * `errorId`. The helper stamps no identity of its own: a shared literal
 * would make `M114.nav.badge_failed` and
 * `M114.dashboard.pending_count_failed` indistinguishable in the logs.
 *
 * Gates, in order, each answering `null` WITHOUT a query:
 *   1. platform flag OFF (FR-039 — nav and dashboard show no count);
 *   2. viewer without `members.read` (FR-026 — the count is a members read).
 *
 * `src/lib/**` is the composition layer (the routes compose the same deps
 * through `buildChangeRequestDeps`); Presentation calls this, never the
 * repo.
 */
import { env } from '@/lib/env';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { canPerform } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import type { Role } from '@/modules/auth/domain/role';
import { countPendingChangeRequests, type PendingChangeRequestsSummary } from '@/modules/members';

export async function readPendingChangeRequests(
  role: Role | (string & {}),
  errorId: string,
): Promise<PendingChangeRequestsSummary | null> {
  if (!env.features.memberChangeApproval) return null;
  if (!canPerform(role, 'members.read')) return null;

  const deps = buildChangeRequestDeps(resolveTenantFromRequest());
  try {
    const result = await countPendingChangeRequests(deps);
    if (result.ok) return result.value;
    logger.error(
      { errorId, tenantId: deps.tenant.slug, err: result.error.message },
      'change-requests.pending-summary: read failed',
    );
    return null;
  } catch (e) {
    logger.error(
      { errorId, tenantId: deps.tenant.slug, err: errKind(e) },
      'change-requests.pending-summary: read threw',
    );
    return null;
  }
}
