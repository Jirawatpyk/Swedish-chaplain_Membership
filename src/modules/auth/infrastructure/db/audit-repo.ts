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
import { db, type DbTx } from '@/lib/db';
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
  /**
   * F5 webhook + rate-limit reject paths (Backend F-02 / PCI F-03 /
   * Threat F-09) carry a short discriminator string describing the
   * reject reason (e.g. `missing_header`, `body_too_large`,
   * `livemode_mismatch`, `api_version_drift`). The reason is encoded
   * into `summary` by the caller; accepting it on the input shape
   * removes the `as unknown as` cast previously needed at route
   * handlers without widening the persisted row.
   *
   * PCI (T044): MUST NOT include raw body, Stripe-Signature header,
   * or any card metadata. A short reason-code string only.
   */
  readonly reason?: string;
}

export interface AuditRepo {
  /** Insert one audit event. NEVER throws across the boundary. */
  append(event: AppendAuditEvent): Promise<void>;
  /**
   * Tx-scoped variant — insert inside the caller's transaction so the
   * audit row commits atomically with the state change (Principle VIII,
   * Path C). Same never-throws contract as `append`.
   */
  appendInTx(tx: DbTx, event: AppendAuditEvent): Promise<void>;
}

/**
 * Shared row-builder — keeps the truncation policy + field mapping in
 * one place so `append` and `appendInTx` cannot drift (S2 review).
 */
function buildAuditRow(event: AppendAuditEvent) {
  const summary =
    event.summary.length > AUDIT_SUMMARY_MAX_LENGTH
      ? event.summary.slice(0, AUDIT_SUMMARY_MAX_LENGTH)
      : event.summary;
  return {
    eventType: event.eventType,
    actorUserId: event.actorUserId,
    targetUserId: event.targetUserId ?? null,
    sourceIp: event.sourceIp ?? null,
    summary,
    requestId: event.requestId,
  };
}

// Object-literal implementation — no class wrapper because the repo
// has no internal state and the interface has exactly one
// implementation. Matches the rest of the codebase's adapter style.
export const auditRepo: AuditRepo = {
  async append(event: AppendAuditEvent): Promise<void> {
    await db.insert(auditLog).values(buildAuditRow(event));
  },

  async appendInTx(tx, event) {
    await tx.insert(auditLog).values(buildAuditRow(event));
  },
};
