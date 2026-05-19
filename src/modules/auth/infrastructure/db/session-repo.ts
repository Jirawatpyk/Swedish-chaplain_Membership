/**
 * Session repository (T066).
 *
 * Generates 32-byte crypto-random hex session ids (64 chars).
 *
 * **E3 (post-ship 2026-05-17) — hash-at-rest**: the PLAINTEXT 64-hex
 * value is returned to the caller exactly once on `create` (used as
 * the cookie value). The DB stores `sha256Hex(plaintext)` as the row
 * primary key. All lookup methods (`findById`, `updateLastSeen`,
 * `delete`, `deleteByUserIdExcept`) accept the plaintext (from the
 * cookie) and hash internally before the SQL `WHERE id = $hash`
 * clause. Consequence: a DB read alone does NOT yield usable session
 * cookies — the plaintext lives only in the user's browser.
 *
 * Migration impact at deploy: migration 0159 TRUNCATEs `sessions`.
 * Every active user is signed out and must sign back in. Acceptable
 * at SweCham scale (~1 active admin session + occasional member
 * sessions). Documented in the migration header.
 *
 * Uses Web Crypto (`crypto.getRandomValues`) so the same module is
 * importable from Edge runtimes if we ever expose a session-aware
 * helper from proxy.ts (the Next.js 16 proxy layer).
 */
import { and, eq, ne } from 'drizzle-orm';
import { db, type DbTx } from '@/lib/db';
import { sessions, type SessionRow } from './schema';
import {
  asSessionToken,
  asUserId,
  type SessionToken,
  type UserId,
} from '@/modules/auth/domain/branded';
import {
  ABSOLUTE_LIFETIME_MS,
  type Session,
} from '@/modules/auth/domain/session';
import { sha256Hex } from '@/lib/crypto';

/**
 * Construct a Domain Session from a freshly-inserted row + the
 * plaintext id (which is NOT in the row — the row holds the hash).
 * Used only by `create` / `createInTx`; never on read paths (where
 * the cookie carries the plaintext separately).
 */
function toDomainCreated(row: SessionRow, plaintext: string): Session {
  return {
    id: asSessionToken(plaintext),
    userId: asUserId(row.userId),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    sourceIp: row.sourceIp,
  };
}

/**
 * Construct a Domain Session for a lookup result. The caller already
 * has the plaintext (it came from their cookie); we surface that as
 * `Session.id` so the rest of the code base sees a consistent value.
 */
function toDomainLookup(row: SessionRow, plaintext: string): Session {
  return {
    id: asSessionToken(plaintext),
    userId: asUserId(row.userId),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    sourceIp: row.sourceIp,
  };
}

function generatePlaintextSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SessionRepo {
  /**
   * Mint a session. The returned `Session.id` is the PLAINTEXT used
   * as the cookie value. The DB row stores `sha256(plaintext)` as
   * its primary key.
   */
  create(args: { userId: UserId; sourceIp: string; now: Date }): Promise<Session>;
  /** Tx-scoped variant of `create` (Path C — A3 redeem-invite). */
  createInTx(
    tx: DbTx,
    args: { userId: UserId; sourceIp: string; now: Date },
  ): Promise<Session>;
  /**
   * Look up a session by the plaintext id from the user's cookie.
   * Hashes internally; returns null if no row matches.
   */
  findById(plaintext: SessionToken): Promise<Session | null>;
  /** Hashes plaintext internally. */
  updateLastSeen(plaintext: SessionToken, now: Date): Promise<void>;
  /** Hashes plaintext internally. */
  delete(plaintext: SessionToken): Promise<void>;
  deleteByUserId(userId: UserId): Promise<number>;
  /** Tx-scoped variant of `deleteByUserId` (Path C — A4 reset-password). */
  deleteByUserIdInTx(tx: DbTx, userId: UserId): Promise<number>;
  /**
   * Delete every session for the user EXCEPT the one identified by
   * `keepPlaintext` (the caller's current cookie). Hashes the keep
   * value internally.
   */
  deleteByUserIdExcept(
    userId: UserId,
    keepPlaintext: SessionToken,
  ): Promise<number>;
}

// Object-literal implementation — no class wrapper; see audit-repo.ts
// for the rationale. Matches the rest of the codebase's adapter style.
export const sessionRepo: SessionRepo = {
  async create(args) {
    const plaintext = generatePlaintextSessionId();
    const hash = sha256Hex(plaintext);
    const expiresAt = new Date(args.now.getTime() + ABSOLUTE_LIFETIME_MS);
    const rows = await db
      .insert(sessions)
      .values({
        id: hash,
        userId: args.userId,
        createdAt: args.now,
        lastSeenAt: args.now,
        expiresAt,
        sourceIp: args.sourceIp,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('session-repo.create: no row returned');
    return toDomainCreated(row, plaintext);
  },

  async createInTx(tx, args) {
    const plaintext = generatePlaintextSessionId();
    const hash = sha256Hex(plaintext);
    const expiresAt = new Date(args.now.getTime() + ABSOLUTE_LIFETIME_MS);
    const rows = await tx
      .insert(sessions)
      .values({
        id: hash,
        userId: args.userId,
        createdAt: args.now,
        lastSeenAt: args.now,
        expiresAt,
        sourceIp: args.sourceIp,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('session-repo.createInTx: no row returned');
    return toDomainCreated(row, plaintext);
  },

  async findById(plaintext) {
    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sha256Hex(plaintext)))
      .limit(1);
    const row = rows[0];
    return row ? toDomainLookup(row, plaintext) : null;
  },

  async updateLastSeen(plaintext, now) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(eq(sessions.id, sha256Hex(plaintext)));
  },

  async delete(plaintext) {
    await db.delete(sessions).where(eq(sessions.id, sha256Hex(plaintext)));
  },

  async deleteByUserId(userId) {
    const result = await db
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    return result.length;
  },

  async deleteByUserIdInTx(tx, userId) {
    const result = await tx
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    return result.length;
  },

  async deleteByUserIdExcept(userId, keepPlaintext) {
    // Delete every session for this user EXCEPT the one whose hash
    // matches `sha256(keepPlaintext)`. The row filter lives in the
    // SQL `where` clause — never post-hoc, which would silently
    // revoke the session the caller asked us to preserve.
    const keepHash = sha256Hex(keepPlaintext);
    const result = await db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepHash)))
      .returning({ id: sessions.id });
    return result.length;
  },
};
