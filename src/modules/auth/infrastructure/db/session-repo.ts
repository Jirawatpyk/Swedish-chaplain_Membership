/**
 * Session repository (T066).
 *
 * Generates 32-byte crypto-random hex session IDs (64 chars), reads
 * and writes the `sessions` table, and translates rows to the pure
 * Domain `Session` type.
 *
 * Uses Web Crypto (`crypto.getRandomValues`) so the same module is
 * importable from Edge runtimes if we ever expose a session-aware
 * helper from proxy.ts (the Next.js 16 proxy layer).
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/lib/db';
import { sessions, type SessionRow } from './schema';
import {
  asSessionId,
  asUserId,
  type SessionId,
  type UserId,
} from '@/modules/auth/domain/branded';
import {
  ABSOLUTE_LIFETIME_MS,
  type Session,
} from '@/modules/auth/domain/session';

function toDomain(row: SessionRow): Session {
  return {
    id: asSessionId(row.id),
    userId: asUserId(row.userId),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    sourceIp: row.sourceIp,
  };
}

function generateSessionId(): SessionId {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return asSessionId(hex);
}

export interface SessionRepo {
  create(args: { userId: UserId; sourceIp: string; now: Date }): Promise<Session>;
  findById(id: SessionId): Promise<Session | null>;
  updateLastSeen(id: SessionId, now: Date): Promise<void>;
  delete(id: SessionId): Promise<void>;
  deleteByUserId(userId: UserId): Promise<number>;
  deleteByUserIdExcept(userId: UserId, keepId: SessionId): Promise<number>;
}

// Object-literal implementation — no class wrapper; see audit-repo.ts
// for the rationale. Matches the rest of the codebase's adapter style.
export const sessionRepo: SessionRepo = {
  async create(args: {
    userId: UserId;
    sourceIp: string;
    now: Date;
  }): Promise<Session> {
    const id = generateSessionId();
    const expiresAt = new Date(args.now.getTime() + ABSOLUTE_LIFETIME_MS);
    const rows = await db
      .insert(sessions)
      .values({
        id,
        userId: args.userId,
        createdAt: args.now,
        lastSeenAt: args.now,
        expiresAt,
        sourceIp: args.sourceIp,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('session-repo.create: no row returned');
    return toDomain(row);
  },

  async findById(id: SessionId): Promise<Session | null> {
    const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const row = rows[0];
    return row ? toDomain(row) : null;
  },

  async updateLastSeen(id: SessionId, now: Date): Promise<void> {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
  },

  async delete(id: SessionId): Promise<void> {
    await db.delete(sessions).where(eq(sessions.id, id));
  },

  async deleteByUserId(userId: UserId): Promise<number> {
    const result = await db
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    return result.length;
  },

  async deleteByUserIdExcept(userId: UserId, keepId: SessionId): Promise<number> {
    // Delete every session for this user EXCEPT keepId. The row filter
    // must live in the SQL `where` clause — previously this method
    // deleted keepId too and filtered the return value post-hoc, which
    // silently revoked the session the caller asked us to preserve.
    const result = await db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepId)))
      .returning({ id: sessions.id });
    return result.length;
  },
};
