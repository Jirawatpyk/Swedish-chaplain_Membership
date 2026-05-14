/**
 * Phase 6 wave-6 batch-3 — `auditEmitErrorMessage` shared helper.
 *
 * Mirrors the H1 pattern (`repo-error-message.ts`) — exhaustive
 * `switch (e.kind)` over the `AuditEmitError` discriminated union so
 * a future variant addition becomes a compile-time error here AND
 * every call site picks up the new wording automatically.
 *
 * Replaces ~7 inline `'message' in r.error ? r.error.message : ...`
 * cascades across apply-quota-effect / archive-event / ingest-
 * webhook-attendee / events-safe-emit-standalone. The previous inline
 * pattern (a) lost `never`-exhaustiveness check (duck-typing via
 * `'message' in obj` instead of tag-discrimination on `.kind`), and
 * (b) emitted inconsistent fallback wording across sites (some used
 * `audit error <kind>`, others used `audit enum unknown: <type>`).
 *
 * The unified message format is `audit enum unknown: <eventType>` for
 * `enum_value_unknown` (the original H3 wording — more informative
 * than the previous bare `audit error <kind>` fallback).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import type { AuditEmitError } from '../../ports/audit-port';

export function auditEmitErrorMessage(e: AuditEmitError): string {
  switch (e.kind) {
    case 'db_error':
      return e.message;
    case 'enum_value_unknown':
      return `audit enum unknown: ${e.eventType}`;
  }
}
