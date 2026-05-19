/**
 * Phase 3F.11.9 (Round 3 comment-analyzer MEDIUM) — canonical helper
 * for the audit-emit-failure logging pattern.
 *
 * Constitution v1.4.0 Principle I sub-clause 4 requires every cross-
 * tenant probe (and the operational-forensic siblings like
 * `broadcast_webhook_batch_missing`) to leave a forensic trail. When
 * the audit_log table itself is unreachable, the trail MUST still
 * reach the pino ops feed — otherwise a "kill the audit-port AND
 * probe" attack would leave zero evidence.
 *
 * Before this helper, 4 use cases duplicated the same try/catch +
 * logger.error pattern (cancel-broadcast, retry-failed-batches,
 * accept-partial-delivery, apply-batch-webhook-event) with slightly
 * different prose in each comment. Round 3 flagged this as drift
 * risk — a future change to the pattern (e.g., adding `requestId`
 * to the log payload) required 4-site coordinated edit.
 *
 * Single source of truth — the helper signature codifies the
 * forensic context the log MUST carry, so future contract changes
 * are coordinated by adding optional fields here, not by 4-site
 * search-replace.
 *
 * The `logKey` defaults to the security-forensic probe key. Pass a
 * different `logKey` (e.g., `'broadcasts.webhook_batch_missing.
 * audit_emit_failed'`) for operational-forensic variants like the
 * Phase 3F.11.3 M3 webhook race-window emit.
 *
 * Why Application layer (not Infrastructure):
 *   - The helper composes `pino` (an infra concern) but is called
 *     EXCLUSIVELY from use-case catch blocks. Co-locating with the
 *     use cases keeps the import graph shallow and matches existing
 *     precedent (use cases import `from '@/lib/logger'` directly,
 *     this helper is the same kind of import).
 *
 * Pure utility — no framework imports beyond pino.
 */
import type { Logger } from 'pino';

export interface AuditEmitFailureContext {
  readonly err: unknown;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly useCase: string;
  /**
   * Use-case-specific context fields (e.g., `probedBroadcastId`,
   * `batchManifestId`, `requestId`). Spread as-is into the pino
   * log object — pino's structured-log serialisers handle the
   * shape via `[key: string]: unknown`.
   */
  readonly [key: string]: unknown;
}

export const DEFAULT_AUDIT_EMIT_FAILURE_LOG_KEY =
  'broadcasts.cross_tenant_probe.audit_emit_failed' as const;

/**
 * Log an audit-emit failure to the pino ops feed with the canonical
 * forensic context. Use ONLY inside a use-case catch block that wraps
 * an `audit.emit` call where the audit row is forensically meaningful
 * (cross-tenant probe, webhook race detection, etc.).
 *
 * @param logger     Pino logger instance (caller supplies; typically
 *                   imported as `from '@/lib/logger'`)
 * @param context    Forensic-context fields. `err`, `tenantId`,
 *                   `actorUserId`, `useCase` are required; other
 *                   use-case-specific fields are spread as-is.
 * @param logKey     Optional override of the default log-key tag.
 *                   Pass `'broadcasts.webhook_batch_missing.audit_emit_failed'`
 *                   for the operational-forensic webhook race variant.
 */
export function logAuditEmitFailure(
  logger: Logger,
  context: AuditEmitFailureContext,
  logKey: string = DEFAULT_AUDIT_EMIT_FAILURE_LOG_KEY,
): void {
  logger.error(context, logKey);
}
