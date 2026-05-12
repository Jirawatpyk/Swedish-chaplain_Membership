/**
 * Shared DB-error sanitiser for F6 Infrastructure layer.
 *
 * Postgres `pg-protocol` error messages include table names, column
 * names, constraint names, and other schema-identifier metadata that
 * are useful for SRE debugging but should never reach Application-
 * layer Result types or audit-log payloads. This helper strips those
 * identifiers + caps the string length for safe propagation.
 *
 * E3 fix (verify-finding 2026-05-12): Phase 3 audit-port.ts had this
 * helper inline; Phase 4 repo adapters forgot to apply the same
 * sanitisation. Extracted here for reuse.
 *
 * IMPORTANT: callers MUST log the FULL error (`e.message + e.stack`)
 * via `logger.error` at the catch site BEFORE passing the sanitised
 * string back to Application. Sanitisation protects the outbound
 * payload; server-side logs keep root-cause forensics.
 *
 * Constitution Principle I sub-clause 4 (audit + log hygiene): no
 * Postgres identifiers in user-facing or audit-log error payloads.
 */

const DB_ERROR_MESSAGE_CAP = 200;

export function sanitizeDbErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Single-pass regex strips both quoted-identifier (`"foo"`) and bare-
  // identifier (`foo`) forms after the canonical Postgres marker words.
  const stripped = raw.replace(
    /(table|column|constraint|relation|function|index|sequence|schema)\s+("[^"]+"|[a-z_][a-z0-9_]*)/gi,
    (_m, kind, ident) =>
      `${kind} ${ident.startsWith('"') ? '"[redacted]"' : '[redacted]'}`,
  );
  return stripped.slice(0, DB_ERROR_MESSAGE_CAP);
}
