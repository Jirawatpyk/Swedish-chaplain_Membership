/**
 * Privacy-preserving ID hash for log output.
 *
 * Raw user IDs and session IDs MUST NOT appear in logs — see
 * `docs/observability.md § 3` and `CLAUDE.md § Secrets`. This helper
 * produces a stable, short correlation key so log lines for the same
 * user can be grouped without storing the identity.
 *
 * Algorithm: djb2 — fast, non-cryptographic, ~4 ns per call. Chosen
 * over SHA-256 because it's called on every authenticated log line
 * and the correlation window (a single production shift) doesn't
 * need collision resistance; auditing uses the raw IDs in the
 * `audit_log` table, not log output.
 *
 * NOT suitable for: password comparison, session token comparison,
 * CSRF token comparison, or any other security-critical equality
 * check. Only use for log correlation.
 *
 * Previously duplicated inline in `sign-in.ts` and `create-user.ts`;
 * consolidated here as a single source of truth.
 */
export function hashId(id: string): string {
  let hash = 5381;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 33) ^ id.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}
