/**
 * `safeAuditEmit` — fail-soft wrapper around `AuditPort.emit`.
 *
 * Purpose: preserve the SECURITY EFFECT of a rejection (e.g.
 * `broadcast_image_unsafe`, `broadcast_image_too_large`,
 * `broadcast_body_image_source_unsafe`) when the audit-storage layer
 * itself hiccups. Caller continues to return their original `Result`
 * (e.g. `err({kind: 'broadcast_image_unsafe', ...})`) — the audit-row
 * loss is logged at error level for ops/SIEM forensics + the http
 * response stays correct (422 reject, not bare 500).
 *
 * Without this helper, an audit-storage transient failure during a
 * security-rejection path bubbles as an unhandled exception, the
 * outer route catch maps to 500 `internal_error`, and the upload/
 * submit gets a misleading error code AND the security event is
 * silently dropped from the audit log.
 *
 * PR-review fix 2026-05-20 closes SF-H2 + SF-H3 + SF-H4.
 *
 * Pure Application logic — no framework imports beyond logger.
 */
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { AuditPortInvariantError } from '../ports/audit-port';
import type {
  AuditPort,
  AuditEmitInput,
  F7AuditPayloadShapes,
  TypedAuditEmitInput,
} from '../ports/audit-port';

/**
 * R8.5 (R7 code-reviewer LOW-1 close) — re-throw guard for
 * programmer-bug invariants raised by `f7AuditAdapter` (e.g.,
 * "mutation tx requires non-null tenantId"). These are NOT transient
 * storage hiccups; they signal a wiring bug that MUST surface as a
 * test failure / 5xx, not be silently swallowed by the fail-soft
 * envelope.
 *
 * Identification: F7.1b B3 closure 2026-05-21 — the adapter now
 * throws a tagged `AuditPortInvariantError` class. The check uses
 * `instanceof` (primary) AND retains the legacy `f7AuditAdapter:`
 * prefix match (back-compat — covers any in-flight error paths that
 * still throw bare `Error` instances during the migration window).
 * Both checks SHOULD return identical results post-migration; the
 * prefix fallback can be deleted in F7.2 once all consumers have
 * adopted the tagged class.
 */
function isAdapterInvariantError(e: unknown): boolean {
  if (e instanceof AuditPortInvariantError) return true;
  return (
    e instanceof Error &&
    e.message.startsWith('f7AuditAdapter:')
  );
}

export async function safeAuditEmit(
  audit: AuditPort,
  tx: unknown,
  event: AuditEmitInput,
  /**
   * H1 Round 2 fix 2026-05-21 (code-reviewer + silent-failure-hunter
   * H-1 closure): callers can pass a small bounded record of forensic
   * context fields that are MERGED into the `logger.error` payload on
   * audit-emit failure. Use case: dispatch + retry paths want
   * `batchManifestId + batchIndex + gatewayStage` in the SIEM pino log
   * line so on-call can correlate a failed audit-emit to a specific
   * batch without pivoting to the (probably-also-failed) audit_log
   * table. Keep the field count small (≤5) + bounded-cardinality so
   * the log line remains scrapeable. Optional — security paths pass
   * nothing; rich-context paths pass `{batchManifestId, gatewayStage}`
   * etc.
   */
  extraContext?: Record<string, unknown>,
): Promise<void> {
  try {
    await audit.emit(tx, event);
  } catch (e) {
    // R8.5 LOW-1 — re-throw programmer-bug invariants. The fail-soft
    // envelope is for TRANSIENT storage hiccups; adapter-invariant
    // throws are a wiring bug + must surface as a test failure.
    if (isAdapterInvariantError(e)) throw e;
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        eventType: event.eventType,
        tenantId: event.tenantId,
        actorUserId: event.actorUserId,
        requestId: event.requestId,
        ...extraContext,
      },
      'broadcasts.audit.emit_failed',
    );
    // R8.5 (R7 silent-failure MED-1 close) — increment the
    // `broadcasts_audit_emit_failed_total{event_type, tenant}`
    // counter so the SLO alarm in `docs/observability.md` (5-min
    // rate ≥ 1 pages on-call) actually fires on these losses.
    // Pre-R8.5 the metric was defined but never incremented — the
    // logger.error line alone was invisible to dashboard alerting.
    broadcastsMetrics.auditEmitFailed(event.eventType, event.tenantId);
    // Intentional: swallow exception so caller's Result return is
    // preserved. The security rejection is the load-bearing effect
    // for the user; the audit row loss is captured in logger + SIEM
    // can alert on `broadcasts.audit.emit_failed` rate.
  }
}

/**
 * R8.1 M-1 — typed counterpart of `safeAuditEmit`. Same fail-soft
 * envelope but the `payload` field is compile-time narrowed via
 * `F7AuditPayloadShapes[E]` (mirrors `AuditPort.emitTyped<E>` from R6.2 H1
 * + R6.7 M-12).
 *
 * Use this when the audit event is in `F7AuditPayloadShapes` AND the
 * call site is a rejection / read-only terminal where audit-storage
 * hiccups must NOT bubble (e.g., the snapshot-template-to-draft
 * refused-deleted branch).
 *
 * Forwards to `audit.emitTyped` to preserve the typed-emit ROUTING
 * (in case a future adapter wires emit + emitTyped to different
 * downstream pipelines, e.g., SIEM vs OTel). Today `emitTyped` is a
 * structural pass-through to `emit`, so behaviour is identical to
 * `safeAuditEmit` — but the type narrowing is preserved.
 */
export async function safeAuditEmitTyped<
  E extends keyof F7AuditPayloadShapes,
>(
  audit: AuditPort,
  tx: unknown,
  event: TypedAuditEmitInput<E>,
): Promise<void> {
  try {
    await audit.emitTyped(tx, event);
  } catch (e) {
    // R8.5 LOW-1 — re-throw adapter invariants (see safeAuditEmit
    // sibling). Mirror behaviour: programmer-bug throws must surface,
    // not be swallowed by the fail-soft envelope.
    if (isAdapterInvariantError(e)) throw e;
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        eventType: event.eventType,
        tenantId: event.tenantId,
        actorUserId: event.actorUserId,
        requestId: event.requestId,
      },
      'broadcasts.audit.emit_failed',
    );
    // R8.5 MED-1 — increment alarm-source counter (see safeAuditEmit).
    broadcastsMetrics.auditEmitFailed(event.eventType, event.tenantId);
  }
}
