/**
 * Branded primitive types (data-model.md § 2.3, § 2.4, § 2.5).
 *
 * A branded type prevents accidental mixing of semantically different
 * strings/uuids — e.g., passing a `SessionId` where a `UserId` is
 * expected becomes a compile-time error.
 *
 * Pure TypeScript — NO framework imports. Constitution Principle III.
 */

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type TokenId = Brand<string, 'TokenId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;
export type EmailAddress = Brand<string, 'EmailAddress'>;

/**
 * An argon2id hash string, as emitted by `PasswordHasher.hash()` and
 * persisted in `users.password_hash`. The brand exists purely to
 * prevent accidental argument swapping in `verify(hashed, plaintext)`
 * — at the wire level both are `string`, and a refactor that flipped
 * the order would authenticate every wrong password. The brand
 * makes that error a compile-time failure (T-11 defence-in-depth).
 */
export type PasswordHash = Brand<string, 'PasswordHash'>;

// --- Constructors -------------------------------------------------------------

export function asUserId(value: string): UserId {
  return value as UserId;
}

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asTokenId(value: string): TokenId {
  return value as TokenId;
}

export function asAuditEventId(value: string): AuditEventId {
  return value as AuditEventId;
}

export function asPasswordHash(value: string): PasswordHash {
  return value as PasswordHash;
}

/**
 * Normalise an email to its canonical (lower-cased, trimmed) form.
 * Throws on inputs that are not plausible emails. Used at every system
 * boundary so that downstream code can trust the brand.
 */
export function asEmailAddress(value: string): EmailAddress {
  const trimmed = value.trim().toLowerCase();
  // Minimal sanity check — full validation lives in zod schemas at the
  // API boundary. The brand merely guarantees normalisation.
  if (!trimmed.includes('@') || trimmed.length < 3) {
    throw new Error(`Invalid email: ${value}`);
  }
  return trimmed as EmailAddress;
}
