/**
 * 059-membership-suspension Task 3 — two-policy portal access resolver.
 *
 * Replaces the F8 Phase 5 Wave C `checkLapsedPortalScope` helper, which was
 * DEAD + BROKEN: it called `cyclesRepo.findActiveForMember`, whose repo-level
 * predicate excludes `status='lapsed'` (`NOT IN ('lapsed','cancelled',
 * 'completed')`), so the "member is lapsed" branch could never be reached in
 * production — only an in-memory unit-test mock could ever hand it a lapsed
 * cycle. It also had zero production callers (imported only by tests).
 *
 * This resolver is built on two Task-1/Task-2 primitives instead:
 *   - `deriveMembershipAccess(cycle, now)` (Domain, Task 1) — classifies a
 *     member's most-recent cycle into `full | suspended | terminated`.
 *   - `cyclesRepo.findLatestCycleForMember` (Task 2) — the member's single
 *     most-recent cycle across ALL statuses (including `lapsed`), so the
 *     Domain predicate can actually see a lapsed row.
 *
 * Two independent route policies key off the derived access state:
 *   - `terminated` (grace-expired lapsed / cancelled) — DENY-BY-DEFAULT
 *     allowlist. Only a narrow whitelist of portal routes (renewal, account,
 *     preferences, the bare dashboard) stay reachable.
 *   - `suspended` (unpaid / pending admin review) — ALLOW-BY-DEFAULT
 *     denylist. The member keeps full portal access EXCEPT a short list of
 *     self-serve benefit-consuming surfaces (e.g. compose a new e-blast).
 *     The real enforcement for suspended members is the per-use-case gate
 *     (Tasks 4-5); this denylist is UX (redirect before the member even
 *     tries the blocked action).
 */
import { logger } from '@/lib/logger';
import { deriveMembershipAccess, type RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type { F8AuditEvent, RenewalAuditEmitter } from '@/modules/renewals/application/ports/renewal-audit-emitter';
import type { RenewalCycleRepo } from '@/modules/renewals/application/ports/renewal-cycle-repo';

/**
 * Allowed portal route prefixes for a `terminated` member (T134) — matched
 * against pathname via `matchesScopePrefix` (exact match, or prefix followed
 * by `/` or `?`). A terminated member can:
 *   - Land on the bare `/portal` dashboard, which renders the "membership
 *     ended" mailto-contact CTA instead of the normal widgets.
 *   - Open `/portal/renewal/[memberId]` to renew (FR-005a)
 *   - Toggle `/portal/preferences/renewals` opt-out (FR-016)
 *   - Use the `/portal/account` hub (058 D2) — covers the FR-016 renewal
 *     opt-out + the GDPR/PDPA data export at `/portal/account/data-export`
 *   - Read (not pay) their own `/portal/invoices` + `/portal/credit-notes`
 *     — Thai tax records, not a benefit (2026-07-14 maintainer decision,
 *     task-15c). Online payment stays blocked (`/api/payments/initiate`
 *     is a separate, still-gated route).
 *   - Sign out from anywhere (auth-public sign-out endpoint)
 *   - View `/portal/sign-in` and `/forgot-password` (auth-public)
 *
 * Everything else (member dashboard widgets, broadcasts, events) is
 * blocked until they renew.
 *
 * NOTE: `'/portal'` is intentionally NOT prefix-matched against its
 * children — see the `isTerminatedAllowedRoute` docstring below. It is
 * listed here (rather than handled as an out-of-band special case) so the
 * array stays the single documented source of truth for "what's reachable",
 * but the matching function special-cases it to exact-path-only.
 */
export const LAPSED_PORTAL_ALLOWED_PREFIXES: readonly string[] = [
  '/portal', // bare dashboard — renders the terminated mailto CTA (exact-only, see below)
  '/portal/renewal',
  '/portal/preferences/renewals',
  '/portal/preferences', // top-level preferences page is informational
  // 058 D2: the consolidated Account hub now hosts the FR-016 renewal
  // opt-out (moved from /portal/preferences/renewals) + the GDPR data
  // export (Art. 20 / PDPA portability, at /portal/account/data-export).
  // Both MUST stay reachable for a terminated member; the legacy routes
  // now redirect here. Prefix-matched, so /portal/account/data-export is
  // covered too.
  '/portal/account',
  '/api/portal/renewal',
  '/api/portal/preferences/renewals',
  // 2026-07-14 maintainer decision (task-15c, corrects the 2026-07-13
  // Task 15 spec amendment which said the opposite — see the corrected
  // FR-005 note in specs/011-renewal-reminders/spec.md): a terminated
  // member's own invoices + credit-notes are Thai tax records (§86/4
  // receipts / RD retention obligations), NOT a membership benefit, so
  // read access MUST survive grace expiry. Covers both the list + detail
  // pages and their read APIs (PDF download, receipt PDF/status, the
  // cmdk invoice-search backend). `/api/portal/invoices` is a BROAD
  // prefix — it also reaches `[invoiceId]/resend` (POST, emails a copy
  // of the invoice to the member). That's a deliberate, documented
  // trade-off: `matchesScopePrefix` only supports prefix+boundary
  // matching, and `resend` shares the same `/api/portal/invoices/{id}/…`
  // prefix as the read routes (the `{id}` segment is dynamic, so there
  // is no narrower literal prefix that reaches the PDF/receipt routes
  // without also reaching resend). Excluding just `resend` would need a
  // suffix-matching mechanism this allowlist doesn't have. Accepted
  // because a terminated member re-sending their OWN invoice email to
  // themselves is low-risk — no cross-member exposure, no financial
  // mutation, no benefit consumption. Online PAYMENT is a separate route
  // (`/api/payments/initiate`, gated by the same `requireMemberContext`
  // chokepoint) that is intentionally NOT on this allowlist — a
  // terminated member can view an unpaid invoice's Pay-now button, but
  // clicking it still 403s, exactly as before this change.
  '/portal/invoices',
  '/api/portal/invoices',
  '/portal/credit-notes',
  '/api/portal/credit-notes',
  // Sign-out + auth-public routes are NOT under /portal/* by default —
  // they live under /sign-out + /forgot-password etc. (auth-public
  // group). Listed here for completeness but won't match the prefix
  // check; documented as defensively-allowed in the policy review.
];

/**
 * Denylist for a `suspended` member (allow-by-default). The real enforcement
 * for broadcast submission is the `submitBroadcast` use-case precondition
 * gate (F7 Task 5) — this denylist is UX only (redirect the compose PAGE
 * before the member even starts drafting).
 *
 * `/api/portal/broadcasts` was REMOVED from this list (review finding,
 * 2026-07-14): it protected nothing — the only route under
 * `/api/portal/broadcasts/` is `acknowledge/route.ts`, a GDPR Art. 7
 * marketing-consent acknowledgement, NOT broadcast submission (submit goes
 * through the F7 `submitBroadcast` use-case, not this API path). Worse, it
 * wrongly BLOCKED `POST /api/portal/broadcasts/acknowledge` for suspended
 * members — acknowledging a received broadcast is not benefit consumption,
 * so it must stay reachable even while suspended (a suspended member still
 * needs to be able to dismiss the consent banner).
 */
export const SUSPENDED_DENYLIST_PREFIXES: readonly string[] = [
  '/portal/broadcasts/new',
];

/**
 * Result of the two-policy access check.
 */
export type PortalAccessDecision =
  | {
      readonly allowed: true;
      readonly reason: 'full' | 'route_whitelisted' | 'suspended_route_allowed' | 'fail_open';
    }
  | {
      readonly allowed: false;
      readonly reason: 'terminated_route_blocked' | 'suspended_route_blocked';
      /** The cycle id whose derived access blocked this request. */
      readonly cycleId: string;
    };

export interface PortalAccessDeps {
  readonly cyclesRepo: Pick<RenewalCycleRepo, 'findLatestCycleForMember'>;
  readonly auditEmitter: Pick<RenewalAuditEmitter, 'emit'>;
  /**
   * Deterministic time source — `deriveMembershipAccess` needs `now` to
   * decide expiry. Production composition wires `systemClock`; tests pin a
   * fixed instant.
   */
  readonly clock: { now(): Date };
}

export interface PortalAccessContext {
  readonly tenantId: string;
  readonly memberId: string;
  readonly pathname: string;
  /**
   * R4-W3 + Round-5 review-finding M5: HTTP method of the (possibly)
   * blocked request — captured on the blocked-action audit row so SRE can
   * distinguish a blocked GET (read attempt) from a blocked POST (mutation
   * attempt) when triaging audit logs.
   *
   * Closed union (Round-5 M5) — bare `string` accepted typos like 'Get' vs
   * 'GET' and defeated forensic dashboard aggregation. Optional for
   * backward-compat with callers that don't pass it — omitted defaults to
   * `null` audit row.
   */
  readonly action?:
    | 'GET'
    | 'POST'
    | 'PUT'
    | 'PATCH'
    | 'DELETE'
    | 'HEAD'
    | 'OPTIONS';
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly requestId?: string | null;
}

/**
 * Decide whether the current request is allowed, keyed on
 * `deriveMembershipAccess` rather than raw status literals.
 *
 * Steps:
 *   1. Look up the member's single most-recent cycle (ANY status,
 *      including `lapsed` — Task 2's `findLatestCycleForMember`). A read
 *      failure here FAILS OPEN (never lock every member out on a DB blip);
 *      the fail-open is logged, not silently swallowed.
 *   2. Derive `access` from the cycle + current time.
 *   3. `full` → allow.
 *   4. `terminated` → deny-by-default allowlist (`isTerminatedAllowedRoute`);
 *      a non-whitelisted route is blocked + audited.
 *   5. `suspended` → allow-by-default denylist (`isSuspendedDeniedRoute`);
 *      a denied route is blocked + audited.
 */
export async function checkPortalAccess(
  deps: PortalAccessDeps,
  ctx: PortalAccessContext,
): Promise<PortalAccessDecision> {
  let cycle: RenewalCycle | null;
  try {
    cycle = await deps.cyclesRepo.findLatestCycleForMember(
      ctx.tenantId,
      ctx.memberId,
    );
  } catch (e) {
    // FAIL OPEN on read errors — a DB blip must not lock every member out.
    emitFailOpen(deps, ctx, e);
    return { allowed: true, reason: 'fail_open' };
  }

  if (cycle === null) {
    return { allowed: true, reason: 'full' };
  }

  const { access } = deriveMembershipAccess(cycle, deps.clock.now());

  if (access === 'full') {
    return { allowed: true, reason: 'full' };
  }

  if (access === 'terminated') {
    if (isTerminatedAllowedRoute(ctx.pathname)) {
      return { allowed: true, reason: 'route_whitelisted' };
    }
    await emitTerminatedBlockedAudit(deps, ctx, cycle.cycleId);
    return {
      allowed: false,
      reason: 'terminated_route_blocked',
      cycleId: cycle.cycleId,
    };
  }

  // access === 'suspended'
  if (!isSuspendedDeniedRoute(ctx.pathname)) {
    return { allowed: true, reason: 'suspended_route_allowed' };
  }
  await emitSuspendedBlockedAudit(deps, ctx, cycle.cycleId);
  return {
    allowed: false,
    reason: 'suspended_route_blocked',
    cycleId: cycle.cycleId,
  };
}

/**
 * Whether `pathname` is reachable for a `terminated` member.
 *
 * `'/portal'` is deliberately matched EXACT-ONLY (plus a `?query` suffix on
 * the bare path) rather than as a boundary-prefix like every other entry:
 * the boundary-prefix rule (`matchesScopePrefix`) treats any prefix as
 * matching itself, its `?query` form, AND any `/`-delimited child path — so
 * treating `'/portal'` as an ordinary prefix would make it swallow every
 * `/portal/*` route (`/portal/timeline`, `/portal/billing`, …), defeating
 * the deny-by-default allowlist entirely. Every OTHER entry legitimately
 * wants its children included (e.g. `/portal/account/data-export` must
 * match `/portal/account`), so only the bare-dashboard entry needs the
 * narrower rule.
 */
export function isTerminatedAllowedRoute(pathname: string): boolean {
  if (matchesExactOrQuery(pathname, '/portal')) return true;
  return LAPSED_PORTAL_ALLOWED_PREFIXES.some(
    (prefix) => prefix !== '/portal' && matchesScopePrefix(pathname, prefix),
  );
}

/** Whether `pathname` is on the `suspended`-member denylist. */
export function isSuspendedDeniedRoute(pathname: string): boolean {
  return SUSPENDED_DENYLIST_PREFIXES.some((prefix) =>
    matchesScopePrefix(pathname, prefix),
  );
}

function matchesExactOrQuery(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}?`);
}

/**
 * Suggestion review-fix (Phase 5 / US3 backlog close): tighten the prefix
 * match so `/portal/renewal-evil` does NOT match the `/portal/renewal`
 * prefix. The check requires the pathname to EITHER equal a whitelisted
 * prefix OR be followed by a path separator (`/` or `?` for the
 * query-string variant). This rules out path-name confusables that a bare
 * `startsWith` would accept.
 */
function matchesScopePrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  if (!pathname.startsWith(prefix)) return false;
  const next = pathname.charCodeAt(prefix.length);
  // 0x2F = '/', 0x3F = '?'. Anything else (e.g. '-', letters, digits)
  // means the prefix matched only as a substring of a wider route.
  return next === 0x2f || next === 0x3f;
}

/** Common try/log/swallow wrapper shared by the 3 emit sites below. */
async function emitAuditSwallowingFailure(
  deps: PortalAccessDeps,
  ctx: PortalAccessContext,
  event: F8AuditEvent<'lapsed_member_action_blocked' | 'membership_suspended_action_blocked' | 'membership_access_fail_open'>,
  cycleId: string | null,
): Promise<void> {
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

/**
 * `terminated` deny-by-default block. Emits the F8 Phase 5 event that
 * existed before Task 8 — kept as-is; Task 8 only added the SUSPENDED
 * sibling below, it did not rename this one.
 */
async function emitTerminatedBlockedAudit(
  deps: PortalAccessDeps,
  ctx: PortalAccessContext,
  cycleId: string,
): Promise<void> {
  const event: F8AuditEvent<'lapsed_member_action_blocked'> = {
    type: 'lapsed_member_action_blocked',
    payload: {
      cycle_id: cycleId,
      member_id: ctx.memberId,
      blocked_route: ctx.pathname,
      // R4-W3 (staff-review-2026-05-09): HTTP method / logical operation
      // — null when caller does not pass it (legacy site).
      action: ctx.action ?? null,
    },
  };
  await emitAuditSwallowingFailure(deps, ctx, event, cycleId);
}

/**
 * `suspended` allow-by-default denylist block (059-membership-suspension
 * Task 8). Discriminated from `emitTerminatedBlockedAudit` above so
 * dashboards can tell which policy fired — previously both branches
 * emitted the same `lapsed_member_action_blocked` event.
 */
async function emitSuspendedBlockedAudit(
  deps: PortalAccessDeps,
  ctx: PortalAccessContext,
  cycleId: string,
): Promise<void> {
  const event: F8AuditEvent<'membership_suspended_action_blocked'> = {
    type: 'membership_suspended_action_blocked',
    payload: {
      cycle_id: cycleId,
      member_id: ctx.memberId,
      blocked_route: ctx.pathname,
      access_state: 'suspended',
      action: ctx.action ?? null,
    },
  };
  await emitAuditSwallowingFailure(deps, ctx, event, cycleId);
}

/**
 * Fail-OPEN path: `cyclesRepo.findLatestCycleForMember` threw (DB blip).
 * `checkPortalAccess` allows the request rather than locking every member
 * out on a transient read failure. The fail-open is ALWAYS logged
 * (fire-and-forget, swallowed internally so a logging hiccup can never
 * escalate into blocking the request that already decided to fail open),
 * and — since 059-membership-suspension Task 8 — also emits a
 * `membership_access_fail_open` audit row so a sustained fail-open storm
 * (e.g. a partial Neon outage) is forensically visible, not just logged.
 * The audit emit itself is best-effort: a throw here is caught by
 * `emitAuditSwallowingFailure` and never escalates into blocking the
 * request or masking the original read failure.
 */
function emitFailOpen(
  deps: PortalAccessDeps,
  ctx: PortalAccessContext,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  try {
    logger.warn(
      {
        err: message,
        tenantId: ctx.tenantId,
        memberId: ctx.memberId,
        blockedRoute: ctx.pathname,
      },
      '[lapsed-portal-scope] fail-open: cyclesRepo read failed — allowing request',
    );
  } catch {
    // Never let a logging failure escalate into blocking the request.
  }

  const event: F8AuditEvent<'membership_access_fail_open'> = {
    type: 'membership_access_fail_open',
    payload: {
      member_id: ctx.memberId,
      blocked_route: ctx.pathname,
      error: message,
    },
  };
  // Fire-and-forget — `checkPortalAccess`'s catch block already decided to
  // allow the request; this must never turn into an unhandled rejection
  // or delay the response. `emitAuditSwallowingFailure` logs + swallows
  // any emit failure internally.
  void emitAuditSwallowingFailure(deps, ctx, event, null);
}
