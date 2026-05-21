/**
 * Pure helpers for inspecting Postgres error shapes.
 *
 * Lives in `src/lib/` (not `src/modules/auth/infrastructure/`) so the
 * Application layer can import it without a Clean Architecture
 * violation — there is no Drizzle, postgres-js, or any other
 * Infrastructure module reference here. The only knowledge encoded is
 * the Postgres SQLSTATE error-code string, which is a stable public
 * Postgres contract (see https://www.postgresql.org/docs/current/errcodes-appendix.html).
 *
 * Background: F1 enforces the "at least one active admin" invariant
 * with a `BEFORE UPDATE / DELETE` trigger on the `users` table
 * (migration 0003). When the trigger fires it raises an exception
 * with SQLSTATE `23514` (`check_violation`). The Application layer
 * catches this error in `change-role.ts` and `disable-user.ts` and
 * surfaces it as the existing public `last-admin-protection` error
 * code so callers see a consistent shape.
 */

const POSTGRES_CHECK_VIOLATION = '23514';

/**
 * Type-narrow an unknown thrown value to "looks like a Postgres
 * error". postgres-js attaches `code` and `message` strings to its
 * error class; we don't import the class here to keep this file
 * Infrastructure-free.
 */
function isPostgresError(
  error: unknown,
): error is { readonly code: string; readonly message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/**
 * True if the thrown value is the `last-admin-protection` trigger
 * exception raised by `users_last_admin_guard()` in migration 0003.
 *
 * The check is two-step (errcode + message substring) so we don't
 * accidentally swallow an unrelated `check_violation` from a future
 * column constraint. The substring `'last-admin-protection'` is the
 * stable error message used by the trigger.
 */
export function isLastAdminTriggerError(error: unknown): boolean {
  // Drizzle 0.45+ wraps Postgres errors in a `Failed query: ...` message;
  // the original error sits on `.cause`. Walk the chain.
  let cur: unknown = error;
  while (cur !== null && cur !== undefined) {
    if (
      isPostgresError(cur) &&
      cur.code === POSTGRES_CHECK_VIOLATION &&
      cur.message.includes('last-admin-protection')
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return false;
}

/**
 * Concatenate `error.message` across the entire `.cause` chain into a
 * single inspectable string. Use this when you need to substring-match
 * against a Postgres error (e.g. unique-violation detection in repo
 * adapters) — Drizzle 0.45+ wraps the original Postgres error and the
 * trigger / constraint message lives on `.cause.message`, not the
 * top-level message.
 */
export function errorChainMessage(error: unknown): string {
  const parts: string[] = [];
  let cur: unknown = error;
  while (cur instanceof Error) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  if (parts.length === 0 && error !== null && error !== undefined) {
    parts.push(String(error));
  }
  return parts.join(' | ');
}

/**
 * SQLSTATE 23505 = unique_violation. Walks the cause chain so it
 * works with Drizzle 0.45+ wrapped errors. Returns true when any
 * link in the chain is a Postgres error with code 23505.
 */
export function isUniqueViolation(error: unknown): boolean {
  let cur: unknown = error;
  while (cur !== null && cur !== undefined) {
    if (isPostgresError(cur) && cur.code === '23505') return true;
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return false;
}

/**
 * Format a storage error for `storage_error.detail` payloads on
 * `Result.err` returns. Lifted from `drizzle-image-allowlist-repo.ts` +
 * `drizzle-broadcast-templates-repo.ts` 2026-05-21 (review finding
 * simplifier H3 — duplicate `describeStorageError` in 2 repos).
 *
 * Returns `"<chained messages joined by ' | '> [<sqlstate>]"` when a
 * Postgres SQLSTATE is present anywhere in the cause chain, else just
 * the chained-messages string. (M2 Round 2 docstring fix 2026-05-21 —
 * previously claimed "top-level message" but `errorChainMessage`
 * actually walks the FULL `.cause` chain and joins with ` | `, so the
 * old wording understated the behaviour.)
 *
 * The trailing `[<code>]` lets ops grep the audit-event payload for
 * systemic violations (e.g. `[23P01]` indicates a stale read after a
 * schema migration).
 *
 * Uses `errorChainMessage` for the message-chain walk so behaviour
 * stays consistent with auth + invoicing call sites.
 */
export function describeStorageError(error: unknown): string {
  const message = errorChainMessage(error);
  let cur: unknown = error;
  while (cur !== null && cur !== undefined) {
    if (isPostgresError(cur)) {
      return `${message} [${cur.code}]`;
    }
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return message;
}
