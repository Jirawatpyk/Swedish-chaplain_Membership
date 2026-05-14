/**
 * Phase 6 wave-6 batch-3 — `auditEmitErrorMessage` shared helper.
 *
 * Mirrors the H1 pattern (`repo-error-message.ts`) — exhaustive
 * `switch (e.kind)` over the `AuditEmitError` discriminated union so
 * a future variant addition becomes a compile-time error here AND
 * every call site picks up the new wording automatically.
 *
 * **R3-IMP-4 (round-12)** — accurate scope:
 *   Currently called from 8 sites across 3 files:
 *     - `apply-quota-effect.ts` (4 sites — partnership + cultural × room/over-quota)
 *     - `archive-event.ts` (3 sites — partnership reversal + cultural reversal + macro)
 *     - `toggle-event-category.ts` (1 site — macro)
 *   Plus the internal call inside `emit-quota-scope-audit.ts` (1 site,
 *   exercises both arms in unit tests). Future call sites in
 *   `ingest-webhook-attendee` or `events-safe-emit-standalone` should
 *   adopt this helper rather than reintroducing the inline duck-typed
 *   `'message' in r.error ? ...` cascade.
 *
 * Replaced 8 inline `'message' in r.error ? r.error.message :
 * 'audit error <kind>'` cascades. The previous inline pattern
 * (a) lost `never`-exhaustiveness check (duck-typing via
 * `'message' in obj` instead of tag-discrimination on `.kind`), and
 * (b) emitted inconsistent fallback wording across sites (some used
 * `audit error <kind>`, others used `audit enum unknown: <type>`).
 *
 * The unified message format is `audit enum unknown: <eventType>` for
 * `enum_value_unknown` (the original H3 wording — more informative
 * than the previous bare `audit error <kind>` fallback).
 *
 * **R3-IMP-3 (round-12)** — explicit `never` exhaustiveness guard:
 *   The trailing `default` arm asserts `const _exhaustive: never = e`
 *   so the switch is exhaustive by TWO mechanisms:
 *     1. Return-type narrowing (`: string` declared return — TS would
 *        already infer `string | undefined` if a case is missed).
 *     2. Explicit `never` assignment — survives accidental return-type
 *        loosening AND documents the intent for future readers.
 *   Adding a new variant to `AuditEmitError` in audit-port.ts produces
 *   a compile-time error here AND every call site picks up the new
 *   wording automatically.
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
    default: {
      const _exhaustive: never = e;
      return `audit error unknown kind: ${
        (_exhaustive as { kind: string }).kind
      }`;
    }
  }
}
