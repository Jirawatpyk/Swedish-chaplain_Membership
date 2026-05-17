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
 * insert per spec FR-012 FR-012.
 *
 * **Never-throws contract** — both `append` and `appendInTx` catch any
 * DB error and degrade to `logger.error` + `authMetrics.auditMissing`.
 * The append-only audit row is diagnostic; the upstream mutation has
 * already committed (or, for `appendInTx`, the surrounding caller-owned
 * tx will still commit if the audit insert is the LAST step and we
 * swallow). Constitution Principle VIII authorises this trade-off:
 * losing an audit row to a transient Neon hiccup is preferable to
 * masking a successful user-facing action behind a 500.
 *
 * Tests pin both behaviours:
 *   tests/unit/auth/infrastructure/audit-repo-never-throws.test.ts
 */
import { db, type DbTx } from '@/lib/db';
import { auditLog } from './schema';
import {
  AUDIT_SUMMARY_MAX_LENGTH,
  type ActorRef,
  type AuditEventType,
} from '@/modules/auth/domain/audit-event';
import type { UserId } from '@/modules/auth/domain/branded';
import { logger } from '@/lib/logger';
import { authMetrics } from '@/lib/metrics';

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
    try {
      await db.insert(auditLog).values(buildAuditRow(event));
    } catch (error) {
      // Honor the never-throws contract — log + metric + swallow.
      // The upstream mutation has already committed; surfacing a 500
      // here would mask a successful user-facing action.
      logger.error(
        { err: error, eventType: event.eventType, requestId: event.requestId },
        'audit.append.failed',
      );
      authMetrics.auditMissing(event.eventType);
    }
  },

  async appendInTx(tx, event) {
    try {
      await tx.insert(auditLog).values(buildAuditRow(event));
    } catch (error) {
      // G2 (Round 2, 2026-05-17) — Postgres semantics: when ANY
      // statement throws inside an active transaction, the tx
      // enters `ABORT` state. Every subsequent statement AND the
      // COMMIT itself will fail with
      //   "ERROR: current transaction is aborted, commands ignored
      //   until end of transaction block".
      // We swallow the throw locally so it doesn't bubble to the
      // caller, but the underlying tx is poisoned. Therefore:
      //   appendInTx MUST be the LAST statement before the caller's
      //   COMMIT — any later statement (mutation, metric write, or
      //   another audit) will fail.
      // For Path C use cases that REQUIRE atomic audit
      // (create-user.ts, redeem-invite.ts:212, reset-password.ts:215),
      // this constraint is honored by ordering: audit-emit goes last.
      logger.error(
        { err: error, eventType: event.eventType, requestId: event.requestId },
        'audit.appendInTx.failed',
      );
      authMetrics.auditMissing(event.eventType);
    }
  },
};
