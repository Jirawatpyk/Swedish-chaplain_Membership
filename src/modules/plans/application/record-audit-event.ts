/**
 * `record-audit-event` — Application-layer thin wrapper over `AuditPort`.
 *
 * Every F2 use case that mutates state ends with a `recordAuditEvent(...)`
 * call. Centralising the call through this wrapper gives us:
 *
 *   1. A single place to add pre-write structural validation (shape
 *      check against `auditPayloadSchema` — the adapter validates
 *      too, but doing it here returns a typed Result before any
 *      persistence is attempted, so callers can short-circuit cleanly
 *      without depending on the repo error message).
 *   2. A single place to enforce the "audit failure is a use-case
 *      failure" rule — if the audit write fails, the use case MUST
 *      return an error (never silently swallow), because the F2
 *      audit trail is a compliance artefact.
 *
 * Kept deliberately small — this file is just an adapter, not a
 * use case in its own right.
 */

import { err, ok, type Result } from '@/lib/result';
import { auditPayloadSchema, type F2AuditEvent } from '../domain/audit-event';
import type { AuditContext, AuditError, AuditPort } from './ports';

export type RecordAuditEventError =
  | { readonly type: 'invalid_payload'; readonly issues: readonly string[] }
  | { readonly type: 'persist_failed'; readonly message: string };

/**
 * Validate + write an F2 audit event. Returns the same error union the
 * `AuditPort.record` contract promises, re-shaped so use cases can
 * destructure without importing the port directly.
 */
export async function recordAuditEvent(
  audit: AuditPort,
  ctx: AuditContext,
  event: F2AuditEvent,
): Promise<Result<void, RecordAuditEventError>> {
  const parsed = auditPayloadSchema.safeParse(event);
  if (!parsed.success) {
    return err({
      type: 'invalid_payload',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const result = await audit.record(ctx, event);
  if (result.ok) return ok(undefined);

  const portErr = result.error as AuditError;
  if (portErr.type === 'invalid_payload') {
    return err({ type: 'invalid_payload', issues: portErr.issues });
  }
  return err({ type: 'persist_failed', message: portErr.message });
}
