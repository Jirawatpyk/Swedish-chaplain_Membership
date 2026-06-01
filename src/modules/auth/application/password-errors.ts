/**
 * Application-layer password error type — go-live audit S1-P1-13.
 *
 * `MalformedHashError` is thrown by the Infrastructure hasher
 * (`argon2-hasher.ts`) but inspected by Application use-cases (sign-in,
 * change-password) to distinguish "wrong password" from "stored hash is
 * corrupt". It lived in Infrastructure, so the use-cases imported an
 * Infrastructure VALUE — a Principle III (Clean Architecture, NON-NEGOTIABLE)
 * violation. Moved here so the use-cases depend only on the Application layer;
 * the hasher imports + re-exports it for back-compat.
 *
 * Pure TypeScript — no framework/ORM imports.
 */
export class MalformedHashError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('argon2 verify: malformed hash');
    this.name = 'MalformedHashError';
    this.cause = cause;
  }
}
