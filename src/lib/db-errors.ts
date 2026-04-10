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
  if (!isPostgresError(error)) return false;
  return (
    error.code === POSTGRES_CHECK_VIOLATION &&
    error.message.includes('last-admin-protection')
  );
}
