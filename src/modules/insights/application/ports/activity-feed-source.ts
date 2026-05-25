/**
 * F9 `ActivityFeedSource` port (US1 / FR-003 / data-model).
 *
 * The near-real-time dashboard activity feed — a LIVE read of recent audit
 * events, SEPARATE from the cached snapshot so a just-occurred event is visible
 * without waiting for the next refresh (research R1). Implemented by an adapter
 * that calls the auth barrel's `listRecentAuditEvents` (auth owns `audit_log`).
 */
import type { TenantContext } from '@/modules/tenants';

export interface ActivityFeedItem {
  readonly id: string;
  /** Audit event type — presentation maps to a localised label (FR-034). */
  readonly eventType: string;
  readonly actorUserId: string;
  readonly summary: string;
  /** ISO 8601 UTC; presentation renders relative + per-locale. */
  readonly occurredAt: string;
}

export interface ActivityFeedSource {
  recent(ctx: TenantContext, limit: number): Promise<readonly ActivityFeedItem[]>;
}
