/**
 * F9 `ActivityFeedSource` adapter (US1 / T029).
 *
 * Reads recent audit events via the auth PUBLIC BARREL (`listRecentAuditEvents`
 * + `auditReadAdapter`) — no deep/foreign-table imports (Constitution
 * Principle III). Maps to the presentation-friendly `ActivityFeedItem`.
 */
import { listRecentAuditEvents, auditReadAdapter } from '@/modules/auth';
import type { TenantContext } from '@/modules/tenants';
import type {
  ActivityFeedItem,
  ActivityFeedSource,
} from '../../application/ports/activity-feed-source';

export const activityFeedSourceAdapter: ActivityFeedSource = {
  async recent(ctx: TenantContext, limit: number): Promise<readonly ActivityFeedItem[]> {
    const result = await listRecentAuditEvents({ limit }, ctx, {
      auditRead: auditReadAdapter,
    });
    // On a DB read failure the use-case has already logged the cause; the
    // activity feed is the least-critical dashboard widget, so degrade to an
    // empty feed rather than propagating a throw that would 500 the whole
    // dashboard. Intentional graceful degradation (not a dead branch).
    if (!result.ok) return [];
    return result.value.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      actorUserId: e.actorUserId,
      summary: e.summary,
      occurredAt: e.occurredAt.toISOString(),
    }));
  },
};
