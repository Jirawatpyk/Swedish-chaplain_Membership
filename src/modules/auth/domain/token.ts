/**
 * Password reset and invitation tokens (data-model.md § 2.5, § 2.6).
 *
 * Both share a single-use, time-bound shape. The Application layer
 * enforces the invariants:
 *
 *   - At-most-one live reset token per user (creating a new one
 *     consumes any existing un-consumed tokens for the same user).
 *   - Pending UserAccount + Invitation are created in the same DB
 *     transaction (atomicity).
 *   - `intendedRole` on the invitation is verified against the
 *     pending user's role at redeem time (tamper detection).
 */

import type { TokenId, UserId } from './branded';
import type { Role } from './role';

// --- PasswordResetToken -------------------------------------------------------

export interface PasswordResetToken {
  readonly id: TokenId;
  readonly userId: UserId;
  readonly createdAt: Date;
  readonly expiresAt: Date; // = createdAt + 1 hour
  readonly consumedAt: Date | null;
}

/** Reset token TTL — 1 hour (FR-005, Q3). */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export function isResetTokenValid(token: PasswordResetToken, now: Date): boolean {
  if (token.consumedAt !== null) return false;
  if (token.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Why did a token fail to validate? Used by the reset-password +
 * redeem-invite route handlers to map a single "link-invalid"
 * application error onto HTTP 404 (not-found) vs 410 Gone
 * (expired/used) — the public JSON body remains uniform.
 *
 * `null` input means "no row found in the DB". Otherwise the token
 * is inspected to decide between `used` (consumedAt set) and
 * `expired` (default).
 */
export type TokenFailureReason = 'not-found' | 'used' | 'expired';

export function classifyTokenFailure(
  token: { consumedAt: Date | null } | null,
): TokenFailureReason {
  if (!token) return 'not-found';
  if (token.consumedAt !== null) return 'used';
  return 'expired';
}

// --- Invitation ---------------------------------------------------------------

export interface Invitation {
  readonly id: TokenId;
  readonly userId: UserId;
  readonly invitedByUserId: UserId;
  readonly intendedRole: Role;
  readonly createdAt: Date;
  readonly expiresAt: Date; // = createdAt + 7 days
  readonly consumedAt: Date | null;
}

/** Invitation TTL — 7 days (FR-009, Q3). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isInvitationValid(token: Invitation, now: Date): boolean {
  if (token.consumedAt !== null) return false;
  if (token.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}
