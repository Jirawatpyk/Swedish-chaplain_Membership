/**
 * F8 Phase 5 Wave C · T133 + T134 — lapsed-portal scope enforcement.
 *
 * Lapsed members (those whose most recent renewal cycle is in
 * `lapsed` status) MUST only be allowed to use a narrow whitelist of
 * portal routes per FR-005a. Non-renewal portal API requests + page
 * server components return 403 + emit `lapsed_member_action_blocked`
 * audit so admins can see the access pattern.
 *
 * Architectural note: tasks.md originally placed this in
 * `src/middleware.ts`, but Next.js 16's proxy (the new name for
 * middleware) runs in Edge runtime which CANNOT do DB lookups
 * (postgres-js needs Node). So the lapsed-status check lives in this
 * shared helper called from each F8-relevant portal route handler +
 * page server component. The proxy still does the F8 path-prefix
 * kill-switch (T133b — `proxy.ts` § "1f. FEATURE_F8_RENEWALS
 * kill-switch"); this helper is the second layer doing the per-member
 * status check.
 *
 * Allowed-routes whitelist (T134) is the single source of truth — any
 * future F8 portal surface must be added here OR explicitly rejected
 * by the lapsed-scope policy.
 */
import { logger } from '@/lib/logger';
import type { F8AuditEvent, RenewalAuditEmitter } from '@/modules/renewals/application/ports/renewal-audit-emitter';
import type { RenewalCycleRepo } from '@/modules/renewals/application/ports/renewal-cycle-repo';

/**
 * Allowed portal route prefixes (T134) — matched against pathname via
 * `startsWith`. A lapsed member can:
 *   - Open `/portal/renewal/[memberId]` to renew (FR-005a)
 *   - Toggle `/portal/preferences/renewals` opt-out (FR-016)
 *   - Sign out from anywhere (auth-public sign-out endpoint)
 *   - View `/portal/sign-in` and `/forgot-password` (auth-public)
 *
 * Everything else (member dashboard, billing, broadcasts, events) is
 * blocked until they renew.
 */
export const LAPSED_PORTAL_ALLOWED_PREFIXES: readonly string[] = [
  '/portal/renewal',
  '/portal/preferences/renewals',
  '/portal/preferences', // top-level preferences page is informational
  '/api/portal/renewal',
  '/api/portal/preferences/renewals',
  // Sign-out + auth-public routes are NOT under /portal/* by default —
  // they live under /sign-out + /forgot-password etc. (auth-public
  // group). Listed here for completeness but won't match the prefix
  // check; documented as defensively-allowed in the policy review.
];

/**
 * Result of the lapsed-scope check.
 */
export type LapsedScopeDecision =
  | { readonly allowed: true; readonly reason: 'not_lapsed' | 'route_whitelisted' }
  | {
      readonly allowed: false;
      readonly reason: 'lapsed_route_blocked';
      /** The active cycle id whose status is `lapsed`. */
      readonly cycleId: string;
    };

export interface LapsedPortalScopeDeps {
  readonly cyclesRepo: Pick<RenewalCycleRepo, 'findActiveForMember'>;
  readonly auditEmitter: Pick<RenewalAuditEmitter, 'emit'>;
}

export interface LapsedPortalScopeContext {
  readonly tenantId: string;
  readonly memberId: string;
  readonly pathname: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly requestId?: string | null;
}

/**
 * Decide whether the current request is allowed for a lapsed member.
 * Steps:
 *   1. If the path matches an allowed prefix → allow (cheap path; no
 *      DB read needed).
 *   2. Look up the member's active cycle. If null OR not lapsed →
 *      allow.
 *   3. Otherwise → block + emit `lapsed_member_action_blocked` audit.
 *
 * The path-whitelist short-circuit ahead of the DB read is a
 * deliberate cost optimisation — most member traffic targets the few
 * F8-relevant routes, so we avoid an unnecessary read on those.
 */
export async function checkLapsedPortalScope(
  deps: LapsedPortalScopeDeps,
  ctx: LapsedPortalScopeContext,
): Promise<LapsedScopeDecision> {
  if (isLapsedAllowedRoute(ctx.pathname)) {
    return { allowed: true, reason: 'route_whitelisted' };
  }

  const cycle = await deps.cyclesRepo.findActiveForMember(
    ctx.tenantId,
    ctx.memberId,
  );
  if (!cycle || cycle.status !== 'lapsed') {
    return { allowed: true, reason: 'not_lapsed' };
  }

  // Lapsed + non-whitelisted route — block + audit.
  await emitBlockedAudit(deps, ctx, cycle.cycleId);
  return {
    allowed: false,
    reason: 'lapsed_route_blocked',
    cycleId: cycle.cycleId,
  };
}

/**
 * Suggestion review-fix (Phase 5 / US3 backlog close): tighten the
 * prefix match so `/portal/renewal-evil` does NOT match the
 * `/portal/renewal` prefix. The check now requires the pathname to
 * EITHER equal a whitelisted prefix OR be followed by a path separator
 * (`/` or `?` for the query-string variant). This rules out path-name
 * confusables that the bare `startsWith` accepted.
 *
 * The previous bare `startsWith` was a soft confused-deputy risk: a
 * future operator could accidentally land a `/portal/renewal-admin`
 * page (or any `${prefix}-suffix` route) and have it pass the lapsed
 * gate without explicit policy review.
 */
export function isLapsedAllowedRoute(pathname: string): boolean {
  return LAPSED_PORTAL_ALLOWED_PREFIXES.some((prefix) =>
    matchesScopePrefix(pathname, prefix),
  );
}

function matchesScopePrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  if (!pathname.startsWith(prefix)) return false;
  const next = pathname.charCodeAt(prefix.length);
  // 0x2F = '/', 0x3F = '?'. Anything else (e.g. '-', letters, digits)
  // means the prefix matched only as a substring of a wider route.
  return next === 0x2f || next === 0x3f;
}

async function emitBlockedAudit(
  deps: LapsedPortalScopeDeps,
  ctx: LapsedPortalScopeContext,
  cycleId: string,
): Promise<void> {
  const event: F8AuditEvent<'lapsed_member_action_blocked'> = {
    type: 'lapsed_member_action_blocked',
    payload: {
      cycle_id: cycleId,
      member_id: ctx.memberId,
      blocked_route: ctx.pathname,
    },
  };
  try {
    await deps.auditEmitter.emit(event, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.actorUserId,
      actorRole: 'member',
      correlationId: ctx.correlationId,
      requestId: ctx.requestId ?? null,
    });
  } catch (e) {
    // I7 review-fix: log + swallow (was empty `catch {}`). Fire-and-
    // forget audit per Wave I2 contract — never block the user-facing
    // 403 on logging failure, but DO surface audit-port misconfiguration
    // (e.g. schema drift, JSON-serialise bug on cycle_id payload).
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: ctx.tenantId,
        memberId: ctx.memberId,
        cycleId,
      },
      '[lapsed-portal-scope] audit emit failed',
    );
  }
}
