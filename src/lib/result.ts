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
