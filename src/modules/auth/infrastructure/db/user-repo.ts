/**
 * User repository (T065).
 *
 * Translates Drizzle row types ↔ pure Domain `UserAccount`. Application
 * code (sign-in, change-password, account lifecycle) only depends on
 * the interface declared here, never on Drizzle directly.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users, type UserRow } from './schema';
import {
  asEmailAddress,
  asPasswordHash,
  asUserId,
  type EmailAddress,
  type PasswordHash,
  type UserId,
} from '@/modules/auth/domain/branded';
import type { UserAccount } from '@/modules/auth/domain/user';
import type { Role } from '@/modules/auth/domain/role';

function toDomain(row: UserRow): UserAccount {
  return {
    id: asUserId(row.id),
    email: asEmailAddress(row.email),
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    lastSignInAt: row.lastSignInAt,
    lastPasswordChangedAt: row.lastPasswordChangedAt,
    failedSignInCount: row.failedSignInCount,
    lockedUntil: row.lockedUntil,
    displayName: row.displayName,
  };
}

export interface UserRepo {
  findByEmail(email: EmailAddress): Promise<{ user: UserAccount; passwordHash: PasswordHash | null } | null>;
  findById(id: UserId): Promise<UserAccount | null>;
  updateLastSignIn(id: UserId, at: Date): Promise<void>;
  incrementFailedCount(id: UserId): Promise<number>;
  clearFailedCount(id: UserId): Promise<void>;
  setLocked(id: UserId, until: Date): Promise<void>;
  clearLock(id: UserId): Promise<void>;
  countActiveAdmins(): Promise<number>;
  createPending(args: {
    email: EmailAddress;
    role: Role;
    displayName?: string | null;
  }): Promise<UserAccount>;
  setPasswordHash(id: UserId, hash: PasswordHash, now: Date): Promise<void>;
  activate(id: UserId, now: Date): Promise<void>;
  /** Transition active → disabled. */
  disable(id: UserId): Promise<void>;
  /** Transition disabled → active. */
  enable(id: UserId): Promise<void>;
  /** Update role. No portal-boundary check — caller enforces that. */
  setRole(id: UserId, role: Role): Promise<void>;
  /** List all users (paginated) — used by the admin users list page. */
  list(limit: number, offset: number): Promise<readonly UserAccount[]>;
  /** Total user count for pagination header. */
  countAll(): Promise<number>;
}

class DrizzleUserRepo implements UserRepo {
  async findByEmail(
    email: EmailAddress,
  ): Promise<{ user: UserAccount; passwordHash: PasswordHash | null } | null> {
    const rows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      user: toDomain(row),
      passwordHash: row.passwordHash ? asPasswordHash(row.passwordHash) : null,
    };
  }

  async findById(id: UserId): Promise<UserAccount | null> {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    return row ? toDomain(row) : null;
  }

  async updateLastSignIn(id: UserId, at: Date): Promise<void> {
    await db.update(users).set({ lastSignInAt: at }).where(eq(users.id, id));
  }

  async incrementFailedCount(id: UserId): Promise<number> {
    const rows = await db
      .update(users)
      .set({ failedSignInCount: sql`${users.failedSignInCount} + 1` })
      .where(eq(users.id, id))
      .returning({ count: users.failedSignInCount });
    return rows[0]?.count ?? 0;
  }

  async clearFailedCount(id: UserId): Promise<void> {
    await db
      .update(users)
      .set({ failedSignInCount: 0, lockedUntil: null })
      .where(eq(users.id, id));
  }

  async setLocked(id: UserId, until: Date): Promise<void> {
    await db.update(users).set({ lockedUntil: until }).where(eq(users.id, id));
  }

  async clearLock(id: UserId): Promise<void> {
    await db
      .update(users)
      .set({ lockedUntil: null, failedSignInCount: 0 })
      .where(eq(users.id, id));
  }

  /**
   * Used by `disable-user` and `change-role` (T125 / T127) inside a
   * transaction with `SELECT ... FOR UPDATE` to enforce
   * "at least one active admin always exists" (FR-011 + Edge Case
   * Concurrent last-admin race).
   */
  async countActiveAdmins(): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(sql`${users.role} = 'admin' AND ${users.status} = 'active'`);
    return rows[0]?.count ?? 0;
  }

  async createPending(args: {
    email: EmailAddress;
    role: Role;
    displayName?: string | null;
  }): Promise<UserAccount> {
    const rows = await db
      .insert(users)
      .values({
        email: args.email,
        role: args.role,
        status: 'pending',
        displayName: args.displayName ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('user-repo.createPending: no row returned');
    return toDomain(row);
  }

  async setPasswordHash(id: UserId, hash: PasswordHash, now: Date): Promise<void> {
    await db
      .update(users)
      .set({ passwordHash: hash, lastPasswordChangedAt: now })
      .where(eq(users.id, id));
  }

  async activate(id: UserId, now: Date): Promise<void> {
    await db
      .update(users)
      .set({ status: 'active', lastPasswordChangedAt: now })
      .where(eq(users.id, id));
  }

  async disable(id: UserId): Promise<void> {
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, id));
  }

  async enable(id: UserId): Promise<void> {
    await db
      .update(users)
      .set({ status: 'active', failedSignInCount: 0, lockedUntil: null })
      .where(eq(users.id, id));
  }

  async setRole(id: UserId, role: Role): Promise<void> {
    await db.update(users).set({ role }).where(eq(users.id, id));
  }

  async list(limit: number, offset: number): Promise<readonly UserAccount[]> {
    const rows = await db
      .select()
      .from(users)
      .orderBy(sql`${users.createdAt} DESC`)
      .limit(limit)
      .offset(offset);
    return rows.map(toDomain);
  }

  async countAll(): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);
    return rows[0]?.count ?? 0;
  }
}

export const userRepo: UserRepo = new DrizzleUserRepo();
