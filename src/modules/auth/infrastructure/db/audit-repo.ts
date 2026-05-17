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
 * insert per spec FR-012.
 *
 * **Never-throws contract** — both `append` and `appendInTx` catch any
 * DB error and degrade to `logger.error` + `authMetrics.auditMissing`.
 * The append-only audit row is diagnostic.
 *
 * For `append` (top-level db) the upstream mutation has already
 * committed, so swallowing here is unambiguously safe — the audit
 * row is the only thing lost.
 *
 * For `appendInTx` the situation is more nuanced (N2 Round 3 — was
 * previously documented as "tx still commits if audit is last step"
 * which is technically false): when Postgres throws inside an active
 * transaction, the tx enters `ABORT` state. Every subsequent
 * statement AND the COMMIT itself will fail. We swallow the JS-level
 * throw locally so it does NOT bubble to the caller, but the
 * surrounding tx is poisoned. Callers MUST place audit emit(s) at
 * the TAIL of the tx — no non-audit statement may follow. Verified
 * by ordering in create-user.ts and redeem-invite.ts (single
 * trailing emit). I3 (Round 4): reset-password.ts emits two
 * back-to-back at the tail (`password_reset_completed` +
 * conditional `concurrent_sessions_revoked`); if the first one
 * poisons the tx, the second one's INSERT also fails on ABORT
 * state and is also swallowed (double `auditMissing` metric). In
 * every case the surrounding state-change is fully rolled back —
 * fail-closed outcome consistent with Constitution Principle VIII.
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
 * one place so `append` and `appendInTx` cannot drift (DRY).
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

/**
 * K1 (Round 2) — shared try/catch/log/metric/swallow helper used by
 * both `append` and `appendInTx`. Eliminates the silent-drift risk
 * where one path's swallow policy diverges from the other.
 *
 * Caller invariants:
 *   - `append` (top-level db): the upstream mutation already
 *     committed before this row was attempted, so swallowing here
 *     is safe — the audit row is the only thing lost. A1 contract.
 *   - `appendInTx`: when Postgres throws inside an active
 *     transaction, the tx enters `ABORT` state. Every subsequent
 *     statement AND the COMMIT itself will fail with
 *     "ERROR: current transaction is aborted, commands ignored
 *     until end of transaction block". We swallow the JS-level
 *     throw locally so it does NOT bubble, but the surrounding tx
 *     is still poisoned. Therefore:
 *       appendInTx MUST be the LAST statement before the caller's
 *       COMMIT — any later statement (mutation, metric write,
 *       another audit) WILL fail. Verified by ordering in
 *       create-user.ts, redeem-invite.ts, reset-password.ts.
 *     M4 (Round 3): formerly read "see G2 JSDoc on appendInTx for
 *     details" but the interface method has no JSDoc detail block;
 *     rationale inlined here.
 */
async function tryAppend(
  inserter: () => Promise<unknown>,
  event: AppendAuditEvent,
  op: 'append' | 'appendInTx',
): Promise<void> {
  try {
    await inserter();
  } catch (error) {
    logger.error(
      { err: error, eventType: event.eventType, requestId: event.requestId },
      `audit.${op}.failed`,
    );
    authMetrics.auditMissing(event.eventType);
  }
}

// Object-literal implementation — no class wrapper because the repo
// has no internal state and the interface has exactly one
// implementation. Matches the rest of the codebase's adapter style.
export const auditRepo: AuditRepo = {
  async append(event) {
    await tryAppend(
      () => db.insert(auditLog).values(buildAuditRow(event)),
      event,
      'append',
    );
  },

  async appendInTx(tx, event) {
    await tryAppend(
      () => tx.insert(auditLog).values(buildAuditRow(event)),
      event,
      'appendInTx',
    );
  },
};
