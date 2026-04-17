/**
 * User repository (T065).
 *
 * Translates Drizzle row types ↔ pure Domain `UserAccount`. Application
 * code (sign-in, change-password, account lifecycle) only depends on
 * the interface declared here, never on Drizzle directly.
 */
import { and, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
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
import type { UserAccount, UserStatus } from '@/modules/auth/domain/user';
import type { Role } from '@/modules/auth/domain/role';

/** Filter shape used by the admin users list page (search + role + status). */
export interface UserListFilter {
  readonly q?: string;
  readonly role?: Role;
  readonly status?: UserStatus;
}

function buildFilterConditions(filter: UserListFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.q && filter.q.trim().length > 0) {
    const term = `%${filter.q.trim()}%`;
    const qCondition = or(
      ilike(users.email, term),
      ilike(users.displayName, term),
    );
    if (qCondition) conds.push(qCondition);
  }
  if (filter.role) conds.push(eq(users.role, filter.role));
  if (filter.status) conds.push(eq(users.status, filter.status));
  if (conds.length === 0) return undefined;
  return and(...conds);
}

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
    emailVerified: row.emailVerified,
    requiresPasswordReset: row.requiresPasswordReset,
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
  /**
   * Compensating delete for `createPending` — used when a downstream
   * step (e.g. invitation row insert) fails after the user row has
   * already committed. Refuses to delete unless the row is still
   * `status='pending'` so a race with a successful redemption cannot
   * destroy an active account.
   */
  deletePending(id: UserId): Promise<void>;
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
  /**
   * Filtered + paginated list. Search `q` matches email OR display_name
   * (case-insensitive substring); `role` + `status` are exact matches.
   */
  listWithFilter(
    filter: UserListFilter,
    limit: number,
    offset: number,
  ): Promise<readonly UserAccount[]>;
  /** Total count matching the same filter — powers pagination UI. */
  countWithFilter(filter: UserListFilter): Promise<number>;
}

// Object-literal implementation — no class wrapper; see audit-repo.ts
// for the rationale.
export const userRepo: UserRepo = {
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
  },

  async findById(id: UserId): Promise<UserAccount | null> {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    return row ? toDomain(row) : null;
  },

  async updateLastSignIn(id: UserId, at: Date): Promise<void> {
    await db.update(users).set({ lastSignInAt: at }).where(eq(users.id, id));
  },

  async incrementFailedCount(id: UserId): Promise<number> {
    // Note: if the UPDATE matches no row (user id does not exist,
    // e.g. a race with a concurrent delete), Drizzle returns an
    // empty array and this function silently returns 0. The sign-in
    // use case always calls this after a successful `findByEmail`,
    // so the race window is effectively zero in production. If a
    // future caller has a different assumption, change the return
    // type to `number | null` and branch on the empty case.
    const rows = await db
      .update(users)
      .set({ failedSignInCount: sql`${users.failedSignInCount} + 1` })
      .where(eq(users.id, id))
      .returning({ count: users.failedSignInCount });
    return rows[0]?.count ?? 0;
  },

  async clearFailedCount(id: UserId): Promise<void> {
    await db
      .update(users)
      .set({ failedSignInCount: 0, lockedUntil: null })
      .where(eq(users.id, id));
  },

  async setLocked(id: UserId, until: Date): Promise<void> {
    await db.update(users).set({ lockedUntil: until }).where(eq(users.id, id));
  },

  async clearLock(id: UserId): Promise<void> {
    await db
      .update(users)
      .set({ lockedUntil: null, failedSignInCount: 0 })
      .where(eq(users.id, id));
  },

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
  },

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
  },

  async deletePending(id: UserId): Promise<void> {
    // Guard: only delete if still pending. This prevents a race where
    // create-user's compensation fires AFTER an invitation was redeemed
    // (user flipped to active) from destroying a live account.
    await db
      .delete(users)
      .where(and(eq(users.id, id), eq(users.status, 'pending')));
  },

  async setPasswordHash(id: UserId, hash: PasswordHash, now: Date): Promise<void> {
    // Clearing `requiresPasswordReset` here ensures the reset-password
    // flow (F1) also unblocks users who arrived via the F3 revert link
    // (FR-012b). The flag is flipped ON by the revert use case; this
    // is the single place it is flipped OFF.
    await db
      .update(users)
      .set({
        passwordHash: hash,
        lastPasswordChangedAt: now,
        requiresPasswordReset: false,
      })
      .where(eq(users.id, id));
  },

  async activate(id: UserId, now: Date): Promise<void> {
    await db
      .update(users)
      .set({ status: 'active', lastPasswordChangedAt: now })
      .where(eq(users.id, id));
  },

  async disable(id: UserId): Promise<void> {
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, id));
  },

  async enable(id: UserId): Promise<void> {
    await db
      .update(users)
      .set({ status: 'active', failedSignInCount: 0, lockedUntil: null })
      .where(eq(users.id, id));
  },

  async setRole(id: UserId, role: Role): Promise<void> {
    await db.update(users).set({ role }).where(eq(users.id, id));
  },

  async list(limit: number, offset: number): Promise<readonly UserAccount[]> {
    const rows = await db
      .select()
      .from(users)
      .orderBy(sql`${users.createdAt} DESC`)
      .limit(limit)
      .offset(offset);
    return rows.map(toDomain);
  },

  async countAll(): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);
    return rows[0]?.count ?? 0;
  },

  async listWithFilter(filter, limit, offset) {
    const where = buildFilterConditions(filter);
    const baseQuery = db.select().from(users);
    const rows = await (where ? baseQuery.where(where) : baseQuery)
      .orderBy(sql`${users.createdAt} DESC`)
      .limit(limit)
      .offset(offset);
    return rows.map(toDomain);
  },

  async countWithFilter(filter) {
    const where = buildFilterConditions(filter);
    const baseQuery = db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);
    const rows = await (where ? baseQuery.where(where) : baseQuery);
    return rows[0]?.count ?? 0;
  },
};
