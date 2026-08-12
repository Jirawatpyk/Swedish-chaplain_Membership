/**
 * F9 `activityFeedQuery` use-case (US1 / FR-003).
 *
 * Returns the dashboard's near-real-time activity feed (last N audit events,
 * newest-first) — a LIVE read separate from the cached snapshot. Staff-only
 * (the feed is part of the staff dashboard); members are forbidden.
 *
 * Application layer: orchestrates the `ActivityFeedSource` port; no ORM/
 * framework imports (Principle III). The source self-scopes (its auth reader
 * runs in its own `runInTenant`), so no direct DB tx here → unit-testable.
 */
import { ok, err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { redactSummaryForRole } from '../audit-redaction';
import { isResolvableActor } from './audit-query';
import type { ActorDirectory } from '../ports/actor-directory';
import type {
  ActivityFeedItem,
  ActivityFeedSource,
} from '../ports/activity-feed-source';
// Deep PURE-Domain import (not the barrel): a value import of the auth barrel
// would drag auth-deps' infrastructure singletons (argon2, Upstash, repos)
// into this Application module's graph at eval time.
import type { Role } from '@/modules/auth/domain/role';

// 016 T030/T033 — widened to the full Role union so routes stop casting and
// audit emitters record the LITERAL actor role; the decision arms in this
// file stay explicit per-role checks (deny arms unchanged).
export type ActivityFeedActorRole = Role;

export interface ActivityFeedMeta {
  readonly actorUserId: string;
  readonly actorRole: ActivityFeedActorRole;
  readonly requestId: string;
}

export interface ActivityFeedDeps {
  readonly activitySource: ActivityFeedSource;
  /** Resolves actor UUIDs → display names (FR-003 actor), PDPA-safe (name only). */
  readonly actorDirectory: ActorDirectory;
  /**
   * Whether the viewer holds `insights.activity_unredacted` (016 T058).
   * INJECTED by the composition root, which owns `canPerform` — the Application
   * layer must not re-derive the permission model.
   *
   * Defaults to FALSE (redacted). Fail-closed on purpose: a call site that
   * forgets to thread it gets the safe projection, so an oversight costs
   * fidelity rather than leaking third-party email/phone.
   */
  readonly activityUnredacted?: boolean;
}

export type ActivityFeedError = 'forbidden';

export async function activityFeedQuery(
  input: { readonly limit?: number },
  meta: ActivityFeedMeta,
  ctx: TenantContext,
  deps: ActivityFeedDeps,
): Promise<Result<readonly ActivityFeedItem[], ActivityFeedError>> {
  // Staff-only (the feed is a dashboard widget); members are forbidden. Admin
  // AND the "read-only on finance" manager role both see the FULL feed —
  // FR-007 makes financial figures visible to managers across the dashboard,
  // so the feed no longer drops finance-bearing events (audit-payload PII
  // redaction is a separate concern handled by the F9 audit viewer, FR-011).
  if (meta.actorRole === 'member') return err('forbidden');
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const items = await deps.activitySource.recent(ctx, limit);

  // Resolve the actor display name (FR-003 "actor") in ONE batch, PDPA-safe
  // (display name only, never email — see ActorDirectory). Only UUID-shaped ids
  // are resolvable; `system:*`/anonymous sentinels are left null (the feed
  // renders those rows without an actor rather than a raw sentinel/UUID).
  const resolvableIds = [
    ...new Set(items.map((it) => it.actorUserId).filter(isResolvableActor)),
  ];
  const identities =
    resolvableIds.length > 0 ? await deps.actorDirectory.labelsFor(resolvableIds) : new Map();
  // `identities` only ever contains resolvable (UUID) ids, so a system:*/
  // anonymous id simply misses the map → null (no need to re-check resolvable).
  const withActor: readonly ActivityFeedItem[] = items.map((it) => ({
    ...it,
    actorLabel: identities.get(it.actorUserId)?.displayName ?? null,
  }));

  // Redact third-party email/phone from the free-text summary for the manager
  // projection (staff-review R001 + F9 #9) — shares redactSummaryForRole with
  // the US2 audit viewer; F1 user-management events embed the target email in
  // `summary`. Member company names are intentionally NOT redacted (a manager
  // has member-directory read scope, so they are not out-of-scope PII). Admin:
  // full feed.
  // 016 T058 — keyed on `insights.activity_unredacted`, not on membership of
  // the administrative role set. The two populations are identical today (which
  // is why T034 could land the role-set version first), but they diverge the
  // moment a bundle moves: a role-set check would keep redacting for a
  // non-administrative holder AND — the dangerous direction — keep handing the
  // raw summary to an administrative role whose bundle no longer carries the
  // key. The permission is the thing that actually decides, so it is what the
  // code reads.
  if (!deps.activityUnredacted) {
    return ok(
      withActor.map((it) => ({ ...it, summary: redactSummaryForRole(it.summary, 'manager') })),
    );
  }
  return ok(withActor);
}
