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
import type {
  ActivityFeedItem,
  ActivityFeedSource,
} from '../ports/activity-feed-source';

export type ActivityFeedActorRole = 'admin' | 'manager' | 'member';

export interface ActivityFeedMeta {
  readonly actorUserId: string;
  readonly actorRole: ActivityFeedActorRole;
  readonly requestId: string;
}

export interface ActivityFeedDeps {
  readonly activitySource: ActivityFeedSource;
}

export type ActivityFeedError = 'forbidden';

export async function activityFeedQuery(
  input: { readonly limit?: number },
  meta: ActivityFeedMeta,
  ctx: TenantContext,
  deps: ActivityFeedDeps,
): Promise<Result<readonly ActivityFeedItem[], ActivityFeedError>> {
  if (meta.actorRole === 'member') return err('forbidden');
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  return ok(await deps.activitySource.recent(ctx, limit));
}
