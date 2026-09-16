/**
 * F114 US6 (FR-033, FR-039; research R12) — the pending-change-request
 * summary for the two "at a glance" staff surfaces: the nav badge (staff
 * layout) and the dashboard "Needs attention" item. One indexed
 * `count(*) / min(submitted_at)` query per render (R12 accepts that; no cache).
 *
 * The answer is a DISCRIMINATED result, never `null` (PR-3 review, reliability
 * R-H2). `null` meant BOTH "hidden by design" and "the read faulted"; the
 * dashboard drops items whose count is 0, so a Neon blip rendered the
 * "All clear" empty state while an FR-037 clock was running on a queue nobody
 * could see. Now:
 *
 *   - `hidden`      — the platform flag is OFF (FR-039) or the viewer lacks
 *                     `members.read` (FR-026). Answered WITHOUT a query, in
 *                     that order, and it says WHICH (`reason: 'flag_off' |
 *                     'not_permitted'`, PR-3 review C1): one surface, two
 *                     facts — the first is every viewer, the second is this
 *                     viewer. Nothing is rendered on either surface.
 *   - `ok`          — the summary; the dashboard item exists when `count > 0`
 *                     and the nav badge carries the count.
 *   - `unavailable` — a `Result` error or a throw. The nav shows no badge; the
 *                     dashboard shows the section-failure `InlineAlert`
 *                     (`role="status"` + `tone="destructive"` — the member
 *                     record's UX I9 shape), never the all-clear state.
 *
 * A fault is logged ONCE under the CALLER's `errorId`: a shared literal would
 * make `M114.nav.badge_failed` and `M114.dashboard.pending_count_failed`
 * indistinguishable in the logs (T107).
 *
 * The `TenantContext` is the CALLER's (PR-3 review, SEC-4). The helper used to
 * call `resolveTenantFromRequest()` with no request, which silently ignores
 * the `X-Tenant` test override every other staff surface honours through
 * `resolveTenantFromHeaders(await headers())` — two resolutions of the same
 * request disagreeing is exactly the class Constitution I forbids, even while
 * the override is refused in production.
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
import type { Role } from '@/modules/auth/domain/role';
import type { TenantContext } from '@/modules/tenants';
import { countPendingChangeRequests, type PendingChangeRequestsSummary } from '@/modules/members';

/**
 * WHY nothing is rendered (PR-3 review C1). Both answers are the same SURFACE
 * and different FACTS: `flag_off` is the whole feature dark (FR-039, every
 * viewer), `not_permitted` is this viewer alone (FR-026 — a role change makes
 * it go away). Collapsed into one `hidden`, a manager's own blank badge reads
 * as evidence the flag is off during a cutover check.
 */
export type PendingChangeRequestsHiddenReason = 'flag_off' | 'not_permitted';

export type PendingChangeRequestsRead =
  | { readonly kind: 'ok'; readonly summary: PendingChangeRequestsSummary }
  | { readonly kind: 'hidden'; readonly reason: PendingChangeRequestsHiddenReason }
  | { readonly kind: 'unavailable' };

const HIDDEN_FLAG_OFF: PendingChangeRequestsRead = { kind: 'hidden', reason: 'flag_off' };
const HIDDEN_NOT_PERMITTED: PendingChangeRequestsRead = { kind: 'hidden', reason: 'not_permitted' };
const UNAVAILABLE: PendingChangeRequestsRead = { kind: 'unavailable' };

export async function readPendingChangeRequests(
  tenant: TenantContext,
  role: Role | (string & {}),
  errorId: string,
): Promise<PendingChangeRequestsRead> {
  if (!env.features.memberChangeApproval) return HIDDEN_FLAG_OFF;
  if (!canPerform(role, 'members.read')) return HIDDEN_NOT_PERMITTED;

  const deps = buildChangeRequestDeps(tenant);
  try {
    const result = await countPendingChangeRequests(deps);
    if (result.ok) return { kind: 'ok', summary: result.value };
    logger.error(
      { errorId, tenantId: deps.tenant.slug, err: result.error.message },
      'change-requests.pending-summary: read failed',
    );
    return UNAVAILABLE;
  } catch (e) {
    logger.error(
      { errorId, tenantId: deps.tenant.slug, err: errKind(e) },
      'change-requests.pending-summary: read threw',
    );
    return UNAVAILABLE;
  }
}

/**
 * The nav badge's deadline (PR-3 review, reliability R-H1).
 *
 * The staff LAYOUT awaits this read before it can build the nav config — the
 * count crosses the RSC boundary as a plain href→count map, so a `<Suspense>`
 * boundary does not fit (the sidebar is a client component that can read
 * neither `env` nor `canPerform`, and the config itself carries Lucide icon
 * FUNCTIONS, which cannot cross). The layout renders on EVERY `/admin/**`
 * page, and `src/lib/db.ts` bounds a pooled query at `statement_timeout 5s`
 * plus `connect_timeout 3` — so an unbounded badge read could add ~8 s to the
 * TTFB of every staff page for a number in the sidebar. 1,500 ms is well past
 * the indexed count's measured cost and well inside a page budget.
 */
export const NAV_BADGE_READ_TIMEOUT_MS = 1_500;

/** Sentinel for the race below — never returned to a caller. */
const TIMED_OUT = Symbol('nav-badge-read-timed-out');

/**
 * The nav badge's bounded read: the summary if it arrives inside
 * {@link NAV_BADGE_READ_TIMEOUT_MS}, otherwise `unavailable` (no badge) and
 * ONE `M114.nav.badge_timed_out` line. The losing read is abandoned, not
 * cancelled — Postgres still bounds it by `statement_timeout`, and nothing
 * downstream consumes its value.
 */
export async function readPendingChangeRequestsForNav(
  tenant: TenantContext,
  role: Role | (string & {}),
): Promise<PendingChangeRequestsRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), NAV_BADGE_READ_TIMEOUT_MS);
  });
  try {
    const winner = await Promise.race([
      readPendingChangeRequests(tenant, role, 'M114.nav.badge_failed'),
      deadline,
    ]);
    if (winner !== TIMED_OUT) return winner;
    logger.error(
      { errorId: 'M114.nav.badge_timed_out', tenantId: tenant.slug, timeoutMs: NAV_BADGE_READ_TIMEOUT_MS },
      'change-requests.pending-summary: nav badge read exceeded its deadline',
    );
    return UNAVAILABLE;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
