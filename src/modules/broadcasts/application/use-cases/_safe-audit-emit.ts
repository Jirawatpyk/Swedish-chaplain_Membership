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
import type {
  AuditPort,
  AuditEmitInput,
  F7AuditPayloadShapes,
  TypedAuditEmitInput,
} from '../ports/audit-port';

export async function safeAuditEmit(
  audit: AuditPort,
  tx: unknown,
  event: AuditEmitInput,
): Promise<void> {
  try {
    await audit.emit(tx, event);
  } catch (e) {
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
  }
}
