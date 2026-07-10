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
  /**
   * Human-readable actor display name (FR-003 "actor"), resolved from
   * `actorUserId` in the use-case via the PDPA-safe `ActorDirectory` (display
   * name ONLY, never email). `null` when the actor is a `system:*`/anonymous
   * sentinel or has no matching user — the source itself never populates it.
   */
  readonly actorLabel?: string | null;
  readonly summary: string;
  /** ISO 8601 UTC; presentation renders relative + per-locale. */
  readonly occurredAt: string;
}

export interface ActivityFeedSource {
  recent(ctx: TenantContext, limit: number): Promise<readonly ActivityFeedItem[]>;
}
