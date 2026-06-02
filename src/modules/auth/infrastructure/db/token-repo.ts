/**
 * Token repository — password reset tokens (T097) + invitations (T121).
 *
 * Each token id is 32 bytes of crypto-random entropy rendered as 64 hex
 * characters — same shape as session ids. Collision risk is negligible
 * (≈ 2⁻¹²⁸).
 *
 * **E2 (post-ship 2026-05-17) — hash-at-rest** (mirrors F3 email-change
 * token pattern): the PLAINTEXT 64-hex value is returned to the caller
 * exactly once on create (for delivery in the email URL). The DB stores
 * `sha256Hex(plaintext)` as the row primary key. All lookup methods
 * (`findResetById`, `findInvitationById`, `mark*Consumed`) accept the
 * plaintext from the user-supplied URL and hash internally before the
 * SQL `WHERE id = $hash` clause. Consequence: a DB read alone (SQLi,
 * leaked backup, support-engineer read access) does NOT yield usable
 * reset-link or invitation-link capability.
 *
 * Migration impact at deploy: migration 0159 TRUNCATEs the
 * `password_reset_tokens` table and unconsumed `invitations` rows.
 * Live reset links delivered before deploy stop working; pending
 * invitations must be re-sent by an admin. Acceptable at SweCham
 * scale (≤1 admin + ~131 members; one-time operational cost).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db, type DbTx } from '@/lib/db';
import {
  invitations,
  passwordResetTokens,
  type InvitationRow,
  type PasswordResetTokenRow,
} from './schema';
import {
  asInvitationTokenHash,
  asInvitationTokenId,
  asResetTokenHash,
  asResetTokenId,
  asTokenId,
  asUserId,
  type InvitationTokenId,
  type ResetTokenId,
  type TokenId,
  type UserId,
} from '@/modules/auth/domain/branded';
import type { Role } from '@/modules/auth/domain/role';
import {
  INVITATION_TTL_MS,
  RESET_TOKEN_TTL_MS,
  type Invitation,
  type PasswordResetToken,
} from '@/modules/auth/domain/token';
import { sha256Hex } from '@/lib/crypto';

function toDomainReset(row: PasswordResetTokenRow): PasswordResetToken {
  // I1 (Round 2) — `row.id` is sha256(plaintext); brand as
  // ResetTokenHash so a caller reading `result.token.id` and treating
  // it as a URL value fails to compile. The URL value is the
  // `plaintext` field of `CreateResetResult`.
  return {
    id: asResetTokenHash(row.id),
    userId: asUserId(row.userId),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

function toDomainInvitation(row: InvitationRow): Invitation {
  return {
    id: asInvitationTokenHash(row.id),
    userId: asUserId(row.userId),
    invitedByUserId: asUserId(row.invitedByUserId),
    intendedRole: row.intendedRole,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

/**
 * Generate a cryptographically-random 64-hex plaintext token. Uses Web
 * Crypto so the function is Edge-safe (even though this file also
 * imports Drizzle — callers from Edge can still use the generator via
 * a re-export if needed). Internal to this module; callers receive
 * the appropriately-branded type via `createReset` / `createInvitation`.
 */
function generatePlaintextToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Legacy alias kept for backwards compatibility with the F1 invite
 * route which generates a token id outside the repo. New code should
 * use `createReset` / `createInvitation` which generate + hash + return
 * the plaintext as part of one operation.
 *
 * @deprecated Pre-E2 callers used this to mint a TokenId and pass it
 * to a separate persistence step. The hash-at-rest model needs the
 * plaintext NOT to be persisted, so the caller cannot mint outside the
 * repo. If a test or migration needs this, prefer the in-repo helpers.
 */
export function generateTokenId(): TokenId {
  return asTokenId(generatePlaintextToken());
}

export interface CreateResetResult {
  /**
   * Plaintext token id — delivered to the user via the reset-password
   * email URL. The repo NEVER persists this; callers MUST treat it as
   * a write-once value.
   */
  readonly plaintext: ResetTokenId;
  /**
   * Domain entity reflecting the persisted row. `token.id` is the
   * hash (NOT the plaintext) — safe to log and to use as an
   * audit-trail correlation key.
   */
  readonly token: PasswordResetToken;
}

export interface CreateInvitationResult {
  readonly plaintext: InvitationTokenId;
  readonly invitation: Invitation;
}

export interface TokenRepo {
  /** Mint a reset token. Returns plaintext (for email) + Domain entity. */
  createReset(args: { userId: UserId; now: Date }): Promise<CreateResetResult>;
  /**
   * Tx-scoped variant of `createReset` (P2 Wave-0). Used by `forgotPassword`
   * so the stale-token invalidation + the fresh-token insert commit atomically
   * — a crash between them would strand the user with no live reset link and
   * no email.
   */
  createResetInTx(
    tx: DbTx,
    args: { userId: UserId; now: Date },
  ): Promise<CreateResetResult>;
  /** Look up a reset token by its user-supplied plaintext id (hashed internally). */
  findResetById(plaintext: ResetTokenId): Promise<PasswordResetToken | null>;
  /** Tx-scoped variant of `findResetById` (Path C — A4). */
  findResetByIdInTx(
    tx: DbTx,
    plaintext: ResetTokenId,
  ): Promise<PasswordResetToken | null>;
  markResetConsumed(plaintext: ResetTokenId, now: Date): Promise<void>;
  /** Tx-scoped variant of `markResetConsumed` (Path C — A4). */
  markResetConsumedInTx(
    tx: DbTx,
    plaintext: ResetTokenId,
    now: Date,
  ): Promise<void>;
  /**
   * Mark every still-unconsumed reset token for a user as consumed.
   * Used by `forgotPassword` to invalidate a stale token before issuing
   * a new one (spec FR-005 single-live-token guarantee) and by
   * `resetPassword` as a belt-and-braces cleanup after a successful
   * redemption.
   */
  invalidateAllUnconsumedForUser(userId: UserId, now: Date): Promise<number>;
  /** Tx-scoped variant of `invalidateAllUnconsumedForUser` (Path C — A4). */
  invalidateAllUnconsumedForUserInTx(
    tx: DbTx,
    userId: UserId,
    now: Date,
  ): Promise<number>;

  // --- Invitation tokens (T121, spec US4) ---
  createInvitation(args: {
    userId: UserId;
    invitedByUserId: UserId;
    intendedRole: Role;
    now: Date;
  }): Promise<CreateInvitationResult>;
  /**
   * Tx-scoped variant of `createInvitation`. Used by `createUser` so
   * the invitation insert commits atomically with the matching user +
   * outbox rows.
   */
  createInvitationInTx(
    tx: DbTx,
    args: {
      userId: UserId;
      invitedByUserId: UserId;
      intendedRole: Role;
      now: Date;
    },
  ): Promise<CreateInvitationResult>;
  findInvitationById(
    plaintext: InvitationTokenId,
  ): Promise<Invitation | null>;
  /** Tx-scoped variant of `findInvitationById` (Path C — A3). */
  findInvitationByIdInTx(
    tx: DbTx,
    plaintext: InvitationTokenId,
  ): Promise<Invitation | null>;
  markInvitationConsumed(
    plaintext: InvitationTokenId,
    now: Date,
  ): Promise<void>;
  /** Tx-scoped variant of `markInvitationConsumed` (Path C — A3). */
  markInvitationConsumedInTx(
    tx: DbTx,
    plaintext: InvitationTokenId,
    now: Date,
  ): Promise<void>;
}

// Object-literal implementation — no class wrapper; see audit-repo.ts
// for the rationale.
export const tokenRepo: TokenRepo = {
  async createReset(args: {
    userId: UserId;
    now: Date;
  }): Promise<CreateResetResult> {
    const plaintext = generatePlaintextToken();
    const hash = sha256Hex(plaintext);
    const expiresAt = new Date(args.now.getTime() + RESET_TOKEN_TTL_MS);
    const rows = await db
      .insert(passwordResetTokens)
      .values({
        id: hash,
        userId: args.userId,
        createdAt: args.now,
        expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('token-repo.createReset: no row returned');
    return {
      plaintext: asResetTokenId(plaintext),
      token: toDomainReset(row),
    };
  },

  async createResetInTx(tx, args): Promise<CreateResetResult> {
    const plaintext = generatePlaintextToken();
    const hash = sha256Hex(plaintext);
    const expiresAt = new Date(args.now.getTime() + RESET_TOKEN_TTL_MS);
    const rows = await tx
      .insert(passwordResetTokens)
      .values({
        id: hash,
        userId: args.userId,
        createdAt: args.now,
        expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('token-repo.createResetInTx: no row returned');
    return {
      plaintext: asResetTokenId(plaintext),
      token: toDomainReset(row),
    };
  },

  async findResetById(plaintext) {
    const rows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.id, sha256Hex(plaintext)))
      .limit(1);
    const row = rows[0];
    return row ? toDomainReset(row) : null;
  },

  async findResetByIdInTx(tx, plaintext) {
    const rows = await tx
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.id, sha256Hex(plaintext)))
      .limit(1);
    const row = rows[0];
    return row ? toDomainReset(row) : null;
  },

  async markResetConsumed(plaintext, now) {
    await db
      .update(passwordResetTokens)
      .set({ consumedAt: now })
      .where(eq(passwordResetTokens.id, sha256Hex(plaintext)));
  },

  async markResetConsumedInTx(tx, plaintext, now) {
    await tx
      .update(passwordResetTokens)
      .set({ consumedAt: now })
      .where(eq(passwordResetTokens.id, sha256Hex(plaintext)));
  },

  async invalidateAllUnconsumedForUser(userId, now) {
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
  },

  async invalidateAllUnconsumedForUserInTx(tx, userId, now) {
    const result = await tx
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
  },

  async createInvitation(args) {
    const plaintext = generatePlaintextToken();
    const hash = sha256Hex(plaintext);
    const expiresAt = new Date(args.now.getTime() + INVITATION_TTL_MS);
    const rows = await db
      .insert(invitations)
      .values({
        id: hash,
        userId: args.userId,
        invitedByUserId: args.invitedByUserId,
        intendedRole: args.intendedRole,
        createdAt: args.now,
        expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('token-repo.createInvitation: no row returned');
    return {
      plaintext: asInvitationTokenId(plaintext),
      invitation: toDomainInvitation(row),
    };
  },

  async createInvitationInTx(tx, args) {
    const plaintext = generatePlaintextToken();
    const hash = sha256Hex(plaintext);
    const expiresAt = new Date(args.now.getTime() + INVITATION_TTL_MS);
    const rows = await tx
      .insert(invitations)
      .values({
        id: hash,
        userId: args.userId,
        invitedByUserId: args.invitedByUserId,
        intendedRole: args.intendedRole,
        createdAt: args.now,
        expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row)
      throw new Error('token-repo.createInvitationInTx: no row returned');
    return {
      plaintext: asInvitationTokenId(plaintext),
      invitation: toDomainInvitation(row),
    };
  },

  async findInvitationById(plaintext) {
    const rows = await db
      .select()
      .from(invitations)
      .where(eq(invitations.id, sha256Hex(plaintext)))
      .limit(1);
    const row = rows[0];
    return row ? toDomainInvitation(row) : null;
  },

  async findInvitationByIdInTx(tx, plaintext) {
    const rows = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.id, sha256Hex(plaintext)))
      .limit(1);
    const row = rows[0];
    return row ? toDomainInvitation(row) : null;
  },

  async markInvitationConsumed(plaintext, now) {
    await db
      .update(invitations)
      .set({ consumedAt: now })
      .where(eq(invitations.id, sha256Hex(plaintext)));
  },

  async markInvitationConsumedInTx(tx, plaintext, now) {
    await tx
      .update(invitations)
      .set({ consumedAt: now })
      .where(eq(invitations.id, sha256Hex(plaintext)));
  },
};
