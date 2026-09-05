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
 * 108 PR-B — the exactly-one-primary-contact guard raised by
 * `contacts_assert_one_primary()` (migration 0293). It is a DEFERRED
 * constraint trigger, so the raise surfaces at COMMIT — from `runInTenant`'s
 * transaction wrapper, NOT from the repo method that made the write — which
 * is why use cases map it in their outer `catch`, not in `mapDbError`.
 *
 * Same two-step contract as `isLastAdminTriggerError` (SQLSTATE 23514 +
 * stable message token) so an unrelated check_violation is never swallowed.
 * Returns the live-primary count the trigger reported, so the caller can
 * tell "zero primaries" (→ `no_primary_contact`) from "two" (→
 * `primary_contact_race`); `null` when the error is anything else.
 */
export function primaryContactTriggerViolation(error: unknown): {
  readonly livePrimaries: number;
  readonly memberId: string | null;
  readonly tenantSlug: string | null;
} | null {
  let cur: unknown = error;
  while (cur !== null && cur !== undefined) {
    if (
      isPostgresError(cur) &&
      cur.code === POSTGRES_CHECK_VIOLATION &&
      cur.message.includes('primary-contact-invariant')
    ) {
      // One decoder for every caller (round 4, F4-#9 / F4-#10). The raise is
      // `primary-contact-invariant: member <uuid> in tenant <slug> has <n>
      // live primary contact(s)` — pinned by T031 on the real trigger. A count
      // that cannot be read lands on the ACTIONABLE side (0 → "the member
      // needs a primary"), never on "retry"; a member that cannot be read is
      // null and the caller falls back to its sanitized error.
      const count = /has (\d+) live primary/.exec(cur.message);
      const who = /member ([0-9a-f-]{36}) in tenant (\S+)/i.exec(cur.message);
      return {
        livePrimaries: count ? Number(count[1]) : 0,
        memberId: who?.[1] ?? null,
        tenantSlug: who?.[2] ?? null,
      };
    }
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return null;
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
 * True when the thrown value is a Postgres unique_violation (23505) raised by a
 * SPECIFIC named constraint / index. Walks the `.cause` chain (Drizzle 0.45+
 * wraps the PostgresError) checking the driver-exposed `constraint_name`, then
 * falls back to matching the constraint name inside the joined message text
 * (some wrap layers keep the index name in the message but drop
 * `constraint_name`). Use this to react to ONE constraint while letting every
 * OTHER 23505 surface through its normal path.
 *
 * Example (CRITICAL-1): idempotent credit-note issuance reconciles ONLY on a
 * violation of `credit_notes_source_refund_id_uniq`; a 23505 on any other index
 * (e.g. a PK collision) still maps to `concurrent_state_change`.
 *
 * The `sawUnique` guard prevents a false positive on a NON-23505 error whose
 * message happens to contain the constraint name.
 */
export function isUniqueViolationOnConstraint(
  error: unknown,
  constraintName: string,
): boolean {
  let cur: unknown = error;
  let sawUnique = false;
  while (cur !== null && cur !== undefined) {
    if (isPostgresError(cur) && cur.code === '23505') {
      sawUnique = true;
      const cn = (cur as { constraint_name?: unknown }).constraint_name;
      if (typeof cn === 'string' && cn === constraintName) return true;
    }
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return sawUnique && errorChainMessage(error).includes(constraintName);
}

/**
 * SQLSTATE 23P01 = exclusion_violation. Walks the cause chain so it works with
 * Drizzle 0.45+ wrapped errors (the original PostgresError sits on `.cause`,
 * NOT the top-level `Failed query: …` wrapper — reading `.code` off the wrapper
 * returns `undefined`). Returns true when any link in the chain is a Postgres
 * error with code 23P01. Used by the membership-coverage EXCLUDE
 * (`invoices_membership_coverage_no_overlap`, mig 0281) call sites.
 */
export function isExclusionViolation(error: unknown): boolean {
  let cur: unknown = error;
  while (cur !== null && cur !== undefined) {
    if (isPostgresError(cur) && cur.code === '23P01') return true;
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return false;
}

/**
 * True when the thrown value is a Postgres exclusion_violation (23P01) raised by
 * a SPECIFIC named constraint. Same cause-walking + `constraint_name`-then-message
 * strategy as {@link isUniqueViolationOnConstraint} (some wrap layers keep the
 * constraint name only in the joined message). Use this to react to ONE
 * exclusion constraint while letting every OTHER 23P01 surface normally.
 *
 * The `sawExclusion` guard prevents a false positive on a NON-23P01 error whose
 * message happens to contain the constraint name.
 */
export function isExclusionViolationOnConstraint(
  error: unknown,
  constraintName: string,
): boolean {
  let cur: unknown = error;
  let sawExclusion = false;
  while (cur !== null && cur !== undefined) {
    if (isPostgresError(cur) && cur.code === '23P01') {
      sawExclusion = true;
      const cn = (cur as { constraint_name?: unknown }).constraint_name;
      if (typeof cn === 'string' && cn === constraintName) return true;
    }
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return sawExclusion && errorChainMessage(error).includes(constraintName);
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
