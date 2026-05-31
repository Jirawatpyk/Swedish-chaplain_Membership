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

/**
 * F5R3 SIMPLIFY-H1 (2026-05-16) — H-4 PCI/PDPA hygiene: log only the
 * error CLASS name, never `e.message`. Drizzle/Postgres errors carry
 * SQL fragments + table names + partial parameter bindings in
 * `.message`; Stripe SDK errors carry endpoint URLs + idempotency
 * keys; OTel trace spans + pino logs aggregate at the line-string
 * level so a single leaked stack trace lands in dashboards visible
 * across the org.
 *
 * Use at every `catch (e) { ... }` site that logs the error class:
 *
 *   logger.error({ err: errKind(e), …context }, 'op.failed');
 *
 * Previously inlined as
 *   `e instanceof Error ? e.constructor.name : 'unknown'`
 * at 15+ sites across F5 (route handlers, use-cases, audit adapter,
 * cron handlers, log-optimistic-flip route).
 */
export function errKind(e: unknown): string {
  return e instanceof Error ? e.constructor.name : 'unknown';
}

/**
 * Single-step unwrap of a `Result` error's underlying `cause` — the real Error
 * thrown by infra (e.g. a `NeonDbError`) that a repo wraps as
 * `{ code: 'repo.unexpected', cause }`. Pair with `errKind` for PII-safe
 * diagnostics: `errKind(rootCause(result.error))` (a single `.cause` unwrap on
 * the plain wrapper, then the error CLASS — never `e.message`).
 *
 * Returns the `.cause` (or `undefined` when there is none). Centralises the
 * `(x as { cause?: unknown }).cause` cast hand-rolled at ~9 route + use-case
 * logging sites (code-review Round 2 cleanup) so the unwrap depth + field name
 * live in ONE place. Single-level BY DESIGN — the RepoError wrapper is exactly
 * one `.cause` deep; this does NOT walk a multi-level chain (for that see
 * `errorChainMessage` in `db-errors.ts`).
 */
export function rootCause(error: unknown): unknown {
  return (error as { cause?: unknown } | null | undefined)?.cause;
}
