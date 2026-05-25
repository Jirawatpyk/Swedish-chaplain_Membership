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

/**
 * Audit-event-type prefixes whose summaries can embed financial figures
 * (satang amounts, revenue, refund totals). Managers get a finance-redacted
 * dashboard (FR-007 / SC-011) — the YTD-revenue KPI is hidden upstream, so the
 * activity feed must not re-expose the same figures via raw audit summaries.
 * Prefix-matched so future finance events in these families are redacted
 * automatically without re-touching this list.
 */
const FINANCE_EVENT_PREFIXES = [
  'payment_',
  'invoice_',
  'credit_note_',
  'receipt_',
  'fee_config',
  'online_payment_',
  'tenant_payment',
] as const;

function isFinanceEvent(eventType: string): boolean {
  // Substring `refund` (not just the `refund_` prefix) so out-of-band /
  // stale-pending refund-anomaly events (`out_of_band_refund_detected`,
  // `stale_pending_refund_detected`) are also redacted, not just `refund_*`.
  return (
    eventType.includes('refund') ||
    FINANCE_EVENT_PREFIXES.some((p) => eventType.startsWith(p))
  );
}

export async function activityFeedQuery(
  input: { readonly limit?: number },
  meta: ActivityFeedMeta,
  ctx: TenantContext,
  deps: ActivityFeedDeps,
): Promise<Result<readonly ActivityFeedItem[], ActivityFeedError>> {
  if (meta.actorRole === 'member') return err('forbidden');
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  if (meta.actorRole !== 'manager') {
    return ok(await deps.activitySource.recent(ctx, limit));
  }

  // Manager (finance-redacted): over-fetch then drop finance-bearing events so
  // the feed stays close to `limit` non-finance items rather than going sparse.
  const fetchLimit = Math.min(limit * 3, 100);
  const items = await deps.activitySource.recent(ctx, fetchLimit);
  const redacted = items.filter((item) => !isFinanceEvent(item.eventType)).slice(0, limit);
  return ok(redacted);
}
