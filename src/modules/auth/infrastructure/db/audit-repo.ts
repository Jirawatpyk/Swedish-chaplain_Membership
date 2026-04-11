/**
 * Audit repository (T067).
 *
 * **Append-only by design** — the public interface exposes ONLY an
 * `append()` method. There are no `update()` / `delete()` helpers,
 * even though Drizzle would happily generate them. The DB layer also
 * blocks UPDATE / DELETE / TRUNCATE via the trigger in
 * `drizzle/migrations/0001_audit_log_append_only.sql`. Defense in depth.
 *
 * `summary` is truncated to AUDIT_SUMMARY_MAX_LENGTH (500 chars) before
 * insert per spec FR-012 U1.
 */
import { db } from '@/lib/db';
import { auditLog } from './schema';
import {
  AUDIT_SUMMARY_MAX_LENGTH,
  type ActorRef,
  type AuditEventType,
} from '@/modules/auth/domain/audit-event';
import type { UserId } from '@/modules/auth/domain/branded';

export interface AppendAuditEvent {
  readonly eventType: AuditEventType;
  readonly actorUserId: ActorRef;
  readonly targetUserId?: UserId | null;
  readonly sourceIp?: string | null;
  readonly summary: string;
  readonly requestId: string;
}

export interface AuditRepo {
  /** Insert one audit event. NEVER throws across the boundary. */
  append(event: AppendAuditEvent): Promise<void>;
}

// Object-literal implementation — no class wrapper because the repo
// has no internal state and the interface has exactly one
// implementation. Matches the rest of the codebase's adapter style.
export const auditRepo: AuditRepo = {
  async append(event: AppendAuditEvent): Promise<void> {
    const summary =
      event.summary.length > AUDIT_SUMMARY_MAX_LENGTH
        ? event.summary.slice(0, AUDIT_SUMMARY_MAX_LENGTH)
        : event.summary;

    await db.insert(auditLog).values({
      eventType: event.eventType,
      actorUserId: event.actorUserId,
      targetUserId: event.targetUserId ?? null,
      sourceIp: event.sourceIp ?? null,
      summary,
      requestId: event.requestId,
    });
  },
};
