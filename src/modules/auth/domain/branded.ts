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
/**
 * Plaintext session token (64-hex). The value lives in the user's
 * cookie and is sent back on every authenticated request. The DB
 * stores `sha256(plaintext)` as the session row id (E3 hash-at-rest);
 * sessionRepo hashes incoming SessionToken before SQL lookup.
 *
 * N7 (Round 3): renamed from `SessionId`. Pre-N7 the brand name read
 * as if it referenced the DB row id; post-E3 the brand carried the
 * plaintext cookie value but kept the old name. I2 (Round 4) — the
 * `@deprecated SessionId` alias and `asSessionId` constructor have
 * been removed now that every call site uses the new name.
 */
export type SessionToken = Brand<string, 'SessionToken'>;
/**
 * @deprecated E1 (post-ship 2026-05-17) — use the per-purpose brands
 * `ResetTokenId`, `InvitationTokenId`, `EmailVerificationTokenHash`,
 * or `EmailRevertTokenHash`. The generic `TokenId` survives only
 * because Domain `Invitation` + `PasswordResetToken` aggregates still
 * carry a single `id` field — switching those to discriminated unions
 * is a separate refactor. New code should NOT introduce raw `TokenId`
 * boundaries; use the per-purpose brand at the route handler and let
 * the Application layer narrow.
 */
export type TokenId = Brand<string, 'TokenId'>;
/**
 * Plaintext password-reset token id (64-hex). Returned to the caller
 * by `forgotPassword` (delivered in the reset email URL) and accepted
 * back from the user via `POST /api/auth/reset-password`. The DB
 * stores `sha256(plaintext)` (E2) so a row read alone cannot grant
 * reset-link capability.
 */
export type ResetTokenId = Brand<string, 'ResetTokenId'>;
/**
 * Stored-hash form of the reset token (`sha256(ResetTokenId)`, 64-hex).
 * Lives in `password_reset_tokens.id`. Distinct from `ResetTokenId`
 * so the type system catches "I read the row id and used it as a URL"
 * mistakes (I1 Round 2): without this brand a refactor that swapped
 * `result.token.id` (hash) for `result.plaintext` (URL value) would
 * compile and silently email a hash that the redeem endpoint cannot
 * match.
 */
export type ResetTokenHash = Brand<string, 'ResetTokenHash'>;
/**
 * Plaintext invitation token id (64-hex). Returned to the inviter
 * (delivered in the invitation email URL) and accepted back from the
 * invitee via `POST /api/auth/redeem-invite`. Same hash-at-rest
 * pattern as `ResetTokenId` (E2).
 */
export type InvitationTokenId = Brand<string, 'InvitationTokenId'>;
/** Stored-hash form of the invitation token. Mirrors `ResetTokenHash`. */
export type InvitationTokenHash = Brand<string, 'InvitationTokenHash'>;
/**
 * Hash of an F3 email-change verification token (64-hex). The brand
 * exists for symmetry with `EmailRevertTokenHash` — F3 routes
 * compute the hash inline today; the brand surfaces intent at the
 * type level.
 *
 * O10 (Round 3) — the previously-defined `SessionIdHash` brand was
 * deleted: zero call-sites used it (sessions table stores the hash
 * as a plain `string` column and the application hashes inline at the
 * repo boundary before SQL). The doc-line on `SessionToken` above
 * still describes the plaintext-vs-hash distinction.
 */
export type EmailVerificationTokenHash = Brand<
  string,
  'EmailVerificationTokenHash'
>;
/**
 * Hash of an F3 email-change revert token (64-hex). Same shape and
 * rationale as `EmailVerificationTokenHash`.
 */
export type EmailRevertTokenHash = Brand<string, 'EmailRevertTokenHash'>;
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

export function asSessionToken(value: string): SessionToken {
  return value as SessionToken;
}

export function asTokenId(value: string): TokenId {
  return value as TokenId;
}

/**
 * I3 (Round 2) — `MalformedTokenError` is thrown by the validating
 * `parseResetTokenId` / `parseInvitationTokenId` functions below
 * when the input does NOT match the 64-hex shape produced by Web
 * Crypto + `sha256Hex`. The plain `as*` constructors remain pure
 * casts (test-fixture compatible); production code at trust
 * boundaries should call the validating `parse*` variants so a
 * typo'd / truncated URL surfaces the mistake at the boundary
 * instead of silently never matching in the repo's
 * `sha256Hex(input)` lookup.
 *
 * N8 (Round 3): docstring previously referenced `parseHex64Token*`
 * — the asterisk-glob does not match the actual exports
 * (`parseResetTokenId` / `parseInvitationTokenId`).
 *
 * O11 (Round 3): brandName narrowed to the literal union of valid
 * brand names — pre-fix a typo like `'Resettokenid'` compiled.
 */
// S3 (Round 4) — module-local. Not part of the public type contract;
// no external consumer pattern-matches on the union today.
type ValidatedBrandName = 'ResetTokenId' | 'InvitationTokenId';

export class MalformedTokenError extends Error {
  constructor(brandName: ValidatedBrandName, length: number) {
    super(
      `Malformed ${brandName}: expected 64 lowercase hex characters, got length ${length}`,
    );
    this.name = 'MalformedTokenError';
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * O5 (Round 3) — predicate version of `HEX64` for callers that want
 * to validate without throwing (e.g., zod `.refine(isHex64)`).
 */
export function isHex64(value: string): boolean {
  return HEX64.test(value);
}

function assertHex64(value: string, brandName: ValidatedBrandName): void {
  if (!isHex64(value)) {
    throw new MalformedTokenError(brandName, value.length);
  }
}

/**
 * O2 (Round 3) — generic parse helper backing `parseResetTokenId`
 * and `parseInvitationTokenId`. N5: also lowercases the input
 * before validation — email gateways (Microsoft Defender Safe
 * Links, Mimecast) sometimes uppercase URL path components, which
 * would otherwise yield a silent 410 even though the token is
 * structurally valid.
 */
function parseHex64<T extends string>(value: string, brandName: ValidatedBrandName): T {
  const normalised = value.toLowerCase();
  assertHex64(normalised, brandName);
  return normalised as T;
}

export function asResetTokenId(value: string): ResetTokenId {
  return value as ResetTokenId;
}

/** Validating constructor — use at route handlers / URL parsing sites. */
export function parseResetTokenId(value: string): ResetTokenId {
  return parseHex64<ResetTokenId>(value, 'ResetTokenId');
}

export function asResetTokenHash(value: string): ResetTokenHash {
  return value as ResetTokenHash;
}

export function asInvitationTokenId(value: string): InvitationTokenId {
  return value as InvitationTokenId;
}

/** Validating constructor — use at route handlers / URL parsing sites. */
export function parseInvitationTokenId(value: string): InvitationTokenId {
  return parseHex64<InvitationTokenId>(value, 'InvitationTokenId');
}

export function asInvitationTokenHash(value: string): InvitationTokenHash {
  return value as InvitationTokenHash;
}

export function asEmailVerificationTokenHash(
  value: string,
): EmailVerificationTokenHash {
  return value as EmailVerificationTokenHash;
}

export function asEmailRevertTokenHash(value: string): EmailRevertTokenHash {
  return value as EmailRevertTokenHash;
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
