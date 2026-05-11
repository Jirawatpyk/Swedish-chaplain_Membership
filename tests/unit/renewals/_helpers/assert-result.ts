/**
 * Wave J12 S5 — shared `Result<T,E>` narrowing helpers for renewals tests.
 *
 * Replaces the recurring 2-line assertion + early-return pattern:
 *
 *   expect(result.ok).toBe(true);
 *   if (!result.ok) return;
 *   expect(result.value.foo).toBe(...);
 *
 * with one assertion call that narrows `result` for the rest of the test:
 *
 *   assertOk(result);
 *   expect(result.value.foo).toBe(...);
 *
 * `assertOk` is a TS assertion function (`asserts result is Ok<T>`) — after
 * the call, the result's discriminant is narrowed to `ok: true`, so direct
 * `result.value` access is type-safe. On failure it throws an Error showing
 * the wrapped error payload (much better signal than `expect(true).toBe(false)`
 * mismatch with no error context).
 *
 * `assertErr` is the symmetric narrowing for error-path tests.
 *
 * Co-located under `tests/unit/renewals/_helpers/` (renewals-scoped) so the
 * helper does not become a project-wide convention without an explicit
 * decision; other modules can adopt the pattern as needed.
 */
import type { Ok, Err, Result } from '@/lib/result';

export function assertOk<T, E>(
  result: Result<T, E>,
): asserts result is Ok<T> {
  if (!result.ok) {
    throw new Error(
      `assertOk: expected Result.ok=true but got error: ${JSON.stringify(
        result.error,
        null,
        2,
      )}`,
    );
  }
}

export function assertErr<T, E>(
  result: Result<T, E>,
): asserts result is Err<E> {
  if (result.ok) {
    throw new Error(
      `assertErr: expected Result.ok=false but got value: ${JSON.stringify(
        result.value,
        null,
        2,
      )}`,
    );
  }
}
