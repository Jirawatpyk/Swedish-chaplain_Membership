/**
 * Explicit error handling helper (Constitution Principle VIII — every error
 * path explicitly handled, no thrown exceptions crossing the Application
 * boundary).
 *
 * Use in Application layer use cases — the Application layer NEVER throws;
 * it returns `Result<T, E>`. Infrastructure may throw, but the adapter
 * wraps the throw into `err(...)` before returning to Application.
 *
 * Example:
 * ```ts
 * const signIn = async (input): Promise<Result<SignInSuccess, SignInError>> => {
 *   const user = await userRepo.findByEmail(input.email);
 *   if (!user) return err({ code: 'invalid-credentials' });
 *   // …
 *   return ok({ sessionId, user });
 * };
 * ```
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Map the success value of a Result.
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Map the error value of a Result.
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Unwrap or throw — use sparingly (e.g., test assertions). NEVER use in
 * production code that crosses the Application boundary.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw new Error(
    `unwrap called on Err: ${typeof result.error === 'object' ? JSON.stringify(result.error) : String(result.error)}`,
  );
}
