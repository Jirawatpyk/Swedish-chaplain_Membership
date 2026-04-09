/**
 * Token repository — password reset tokens (T097) + invitations (T121,
 * extended in Phase 6).
 *
 * Each token id is 32 bytes of crypto-random entropy rendered as 64 hex
 * characters — same shape as session ids. Collision risk is negligible
 * (≈ 2⁻¹²⁸).
 *
 * Phase 5 (US3) only uses the reset-token half of this module. Phase 6
 * (US4) will add `createInvitation`/`findInvitationById`/
 * `markInvitationConsumed` to the same file so both token flows share
 * the same generation + persistence primitives.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  passwordResetTokens,
  type PasswordResetTokenRow,
} from './schema';
import {
  asTokenId,
  type TokenId,
  type UserId,
} from '@/modules/auth/domain/branded';
import {
  RESET_TOKEN_TTL_MS,
  type PasswordResetToken,
} from '@/modules/auth/domain/token';

function toDomainReset(row: PasswordResetTokenRow): PasswordResetToken {
  return {
    id: asTokenId(row.id),
    userId: row.userId as UserId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

/**
 * Generate a cryptographically-random 64-hex token id. Uses Web Crypto
 * so the function is Edge-safe (even though this file also imports
 * Drizzle — callers from Edge can still use the generator via a
 * re-export if needed).
 */
export function generateTokenId(): TokenId {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return asTokenId(hex);
}

export interface TokenRepo {
  createReset(args: { userId: UserId; now: Date }): Promise<PasswordResetToken>;
  findResetById(id: TokenId): Promise<PasswordResetToken | null>;
  markResetConsumed(id: TokenId, now: Date): Promise<void>;
  /**
   * Mark every still-unconsumed reset token for a user as consumed.
   * Used by `forgotPassword` to invalidate a stale token before issuing
   * a new one (spec FR-005 single-live-token guarantee) and by
   * `resetPassword` as a belt-and-braces cleanup after a successful
   * redemption.
   */
  invalidateAllUnconsumedForUser(userId: UserId, now: Date): Promise<number>;
}

class DrizzleTokenRepo implements TokenRepo {
  async createReset(args: {
    userId: UserId;
    now: Date;
  }): Promise<PasswordResetToken> {
    const id = generateTokenId();
    const expiresAt = new Date(args.now.getTime() + RESET_TOKEN_TTL_MS);
    const rows = await db
      .insert(passwordResetTokens)
      .values({
        id,
        userId: args.userId,
        createdAt: args.now,
        expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('token-repo.createReset: no row returned');
    return toDomainReset(row);
  }

  async findResetById(id: TokenId): Promise<PasswordResetToken | null> {
    const rows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toDomainReset(row) : null;
  }

  async markResetConsumed(id: TokenId, now: Date): Promise<void> {
    await db
      .update(passwordResetTokens)
      .set({ consumedAt: now })
      .where(eq(passwordResetTokens.id, id));
  }

  async invalidateAllUnconsumedForUser(
    userId: UserId,
    now: Date,
  ): Promise<number> {
    const result = await db
      .update(passwordResetTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          isNull(passwordResetTokens.consumedAt),
        ),
      )
      .returning({ id: passwordResetTokens.id });
    return result.length;
  }
}

export const tokenRepo: TokenRepo = new DrizzleTokenRepo();
