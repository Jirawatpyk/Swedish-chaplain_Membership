/**
 * User repository (T065).
 *
 * Translates Drizzle row types ↔ pure Domain `UserAccount`. Application
 * code (sign-in, change-password, account lifecycle) only depends on
 * the interface declared here, never on Drizzle directly.
 */
import { and, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { db, type DbTx } from '@/lib/db';
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
  /**
   * Tx-scoped variant of `findByEmail`. Used by `createUser` so the
   * duplicate check shares the same transaction as the subsequent
   * INSERT — prevents the TOCTOU race that would let two concurrent
   * admin invites both pass the dup check and both commit the user
   * row. Pre-Path-C the check ran in a separate connection; now it
   * holds the row lock for the rest of the tx.
   */
  findByEmailInTx(
    tx: DbTx,
    email: EmailAddress,
  ): Promise<{ user: UserAccount; passwordHash: PasswordHash | null } | null>;
  findById(id: UserId): Promise<UserAccount | null>;
  /**
   * Tx-scoped variant of `findById`. Used by Path C use cases
   * (redeem-invite, reset-password) so the user row is locked inside
   * the same tx that subsequently mutates it — closes the race window
   * where a concurrent disable/role-change could land between read
   * and mutation.
   */
  findByIdInTx(tx: DbTx, id: UserId): Promise<UserAccount | null>;
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
   * Tx-scoped variant of `createPending`. Used by `createUser` so the
   * insert shares the tx with the subsequent invitation + outbox
   * inserts — failure in any later step rolls this row back without
   * needing the compensating-delete dance.
   */
  createPendingInTx(
    tx: DbTx,
    args: {
      email: EmailAddress;
      role: Role;
      displayName?: string | null;
    },
  ): Promise<UserAccount>;
  /**
   * Compensating delete for `createPending` — used when a downstream
   * step (e.g. invitation row insert) fails after the user row has
   * already committed. Refuses to delete unless the row is still
   * `status='pending'` so a race with a successful redemption cannot
   * destroy an active account.
   */
  deletePending(id: UserId): Promise<void>;
  /**
   * In-tx variant of `deletePending` returning the deleted-row COUNT, for the
   * F3 `invitePortal` SAGA compensation (go-live #12-13) which must atomically
   * delete the just-created pending user + its queued outbox row + append a
   * compensation audit in ONE owner-role tx. Same `status='pending'` guard:
   * returns `{ deleted: 0 }` (a no-op) if the user was already redeemed/active —
   * a redeemed account is NEVER destroyed.
   */
  deleteInvitedPendingInTx(tx: DbTx, id: UserId): Promise<{ deleted: number }>;
  /**
   * COMP-1 US2a — anonymise an F1 login account so a GDPR-Art.17 /
   * PDPA-§33-erased member can no longer authenticate. Email → a
   * globally-unique non-routable sentinel (`erased+{userId}@erased.invalid`,
   * lower-cased to survive the functional `lower(email)` unique index),
   * `password_hash` → NULL, `display_name` → '[erased]', `status` → 'disabled'
   * (NULL hash + disabled status are belt-and-suspenders auth blocks),
   * `email_verified` + `requires_password_reset` → false. Keyed by id.
   *
   * Runs in an OWNER-role `DbTx` (the `users` table is cross-tenant — no
   * tenant_id, no RLS — so it cannot join a members `runInTenant` tx; mirrors
   * `deleteInvitedPendingInTx`). Idempotent: the sentinel is computed from the
   * id, so a re-run on an already-erased row sets the byte-identical values
   * with no unique-index violation. `erased` is `false` only when no row matched
   * the id (already hard-deleted / never existed).
   */
  anonymiseErasedInTx(
    tx: DbTx,
    userId: UserId,
  ): Promise<{ readonly erased: boolean }>;
  setPasswordHash(id: UserId, hash: PasswordHash, now: Date): Promise<void>;
  /** Tx-scoped variant of `setPasswordHash` (Path C — A3 / A4). */
  setPasswordHashInTx(
    tx: DbTx,
    id: UserId,
    hash: PasswordHash,
    now: Date,
  ): Promise<void>;
  activate(id: UserId, now: Date): Promise<void>;
  /** Tx-scoped variant of `activate` (Path C — A3). */
  activateInTx(tx: DbTx, id: UserId, now: Date): Promise<void>;
  /**
   * Tx-scoped write of the account's display name — the name the invitee
   * types on the activation form (BUG-022). Kept separate from
   * `activateInTx` so activation stays a pure status flip and only the
   * invite-redemption path opts into writing the name.
   */
  setDisplayNameInTx(tx: DbTx, id: UserId, displayName: string): Promise<void>;
  /**
   * Tx-scoped clear of BOTH `failed_sign_in_count` and `locked_until`
   * in a single UPDATE (Path C — A4). G8 (Round 2): merged from the
   * formerly-separate `clearLockInTx` + `clearFailedCountInTx` which
   * wrote byte-identical SET clauses; the back-to-back call from
   * reset-password issued two redundant UPDATEs per password reset.
   */
  clearLockAndFailedCountInTx(tx: DbTx, id: UserId): Promise<void>;
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

  async findByEmailInTx(
    tx,
    email,
  ) {
    const rows = await tx
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

  async findByIdInTx(tx, id) {
    // G1 (Round 2, 2026-05-17) — `.for('update')` honours the
    // interface JSDoc claim "locks the row" so a concurrent disable
    // / role-change between the read and the subsequent UPDATE
    // inside the tx blocks (or sees the post-commit state on retry).
    // Pre-G1 the bare SELECT did NOT take a row lock and the
    // documented race window was open.
    const rows = await tx
      .select()
      .from(users)
      .where(eq(users.id, id))
      .for('update')
      .limit(1);
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

  async createPendingInTx(tx, args) {
    const rows = await tx
      .insert(users)
      .values({
        email: args.email,
        role: args.role,
        status: 'pending',
        displayName: args.displayName ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('user-repo.createPendingInTx: no row returned');
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

  async deleteInvitedPendingInTx(tx, id) {
    // Same `status='pending'` guard as deletePending — a redeemed/active
    // account is never destroyed. RETURNING lets the SAGA distinguish a real
    // rollback (deleted:1) from a race no-op (deleted:0, user already active).
    const rows = await tx
      .delete(users)
      .where(and(eq(users.id, id), eq(users.status, 'pending')))
      .returning({ id: users.id });
    return { deleted: rows.length };
  },

  async anonymiseErasedInTx(tx, userId) {
    // Sentinel is derived from the id → always unique per user AND already
    // lowercase, so the functional `lower(email)` unique index never trips,
    // even on a re-run against the already-anonymised row (idempotent).
    //
    // Denial-of-erasure edge: if some OTHER live account already held
    // `erased+<thisUserId>@erased.invalid`, this UPDATE would collide on the
    // global `lower(email)` unique index and throw — blocking the erasure.
    // Accepted, NOT defended here, because it is not reachable in practice:
    // (a) the app is invitation-only — there is no self-registration route to
    // plant such an address, and (b) `userId` is an unguessable UUIDv4, so an
    // attacker cannot pre-register the exact sentinel for a future target.
    // Rejecting the reserved `@erased.invalid` domain at the email-collection
    // boundary (invite / member-create) is a documented follow-up, out of
    // Task 2 scope — it touches those routes plus a cross-module email-policy
    // decision (the sentinel domain is owned by the members context).
    const sentinelEmail = `erased+${userId}@erased.invalid`;
    const updated = await tx
      .update(users)
      .set({
        email: sentinelEmail,
        passwordHash: null,
        displayName: '[erased]',
        status: 'disabled',
        emailVerified: false,
        requiresPasswordReset: false,
      })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    return { erased: updated.length === 1 };
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

  async setPasswordHashInTx(tx, id, hash, now) {
    await tx
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

  async activateInTx(tx, id, now) {
    await tx
      .update(users)
      .set({ status: 'active', lastPasswordChangedAt: now })
      .where(eq(users.id, id));
  },

  async setDisplayNameInTx(tx, id, displayName) {
    await tx
      .update(users)
      .set({ displayName })
      .where(eq(users.id, id));
  },

  async clearLockAndFailedCountInTx(tx, id) {
    await tx
      .update(users)
      .set({ lockedUntil: null, failedSignInCount: 0 })
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
