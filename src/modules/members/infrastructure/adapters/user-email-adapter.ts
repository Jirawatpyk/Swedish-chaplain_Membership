/**
 * UserEmailPort adapter — FR-012a step (ii).
 *
 * UPDATE users SET email = $1, email_verified = $2 WHERE id = $3
 * inside the caller's transaction. Returns the previous email so the
 * caller can stamp it on the audit payload + the revert-notification
 * outbox row.
 *
 * Error mapping:
 *   - unique-constraint violation on `users_email_lower_unique`
 *     → `repo.conflict` (another user already has this email)
 *   - row not found → `repo.not_found`
 *   - other → `repo.unexpected`
 */

import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { err, ok } from '@/lib/result';
import { errorChainMessage, isUniqueViolation } from '@/lib/db-errors';
// Direct schema import to reuse the caller's transaction; same escape
// hatch auth-session-revocation-port uses. Wrapping in a public F1 use
// case would add no behaviour.
import { users } from '@/modules/auth/infrastructure/db/schema';
import type { UserEmailPort } from '../../application/ports/user-email-port';

export const userEmailAdapter: UserEmailPort = {
  async updateInTx(tx, update) {
    try {
      // SELECT first so we return the pre-update email; Postgres
      // RETURNING on UPDATE reflects post-SET values, not prior ones.
      const [before] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, update.userId))
        .limit(1);
      if (!before) return err({ code: 'repo.not_found' });

      const set: {
        email: string;
        emailVerified: boolean;
        requiresPasswordReset?: boolean;
      } = {
        email: update.newEmail,
        emailVerified: update.setEmailVerified,
      };
      if (update.setRequiresPasswordReset !== undefined) {
        set.requiresPasswordReset = update.setRequiresPasswordReset;
      }

      const updated = await tx
        .update(users)
        .set(set)
        .where(eq(users.id, update.userId))
        .returning({ id: users.id });
      if (updated.length === 0) return err({ code: 'repo.not_found' });

      return ok({ oldEmail: before.email });
    } catch (e) {
      // Drizzle 0.45+ wraps Postgres errors; the unique-violation
      // SQLSTATE 23505 + message live on the cause chain.
      if (
        isUniqueViolation(e) ||
        /duplicate key|unique constraint/i.test(errorChainMessage(e))
      ) {
        return err({ code: 'repo.conflict', reason: 'email already taken' });
      }
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async isEmailVerified(userId) {
    try {
      const [row] = await db
        .select({ emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!row) return err({ code: 'repo.not_found' });
      return ok(row.emailVerified);
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async isEmailVerifiedBatch(userIds) {
    // Empty input: skip the query — nothing to look up.
    if (userIds.length === 0) return ok(new Set<string>());
    try {
      // `users` is cross-tenant (no tenant_id column); use global db.
      // Same BYPASSRLS / pool-level access as the single isEmailVerified above.
      // SELECT id, email_verified WHERE id IN (...) — one round-trip regardless
      // of how many userIds are provided. The caller (DV-11 loader) passes only
      // the live-contact userIds for a single member (typically 1–5).
      const rows = await db
        .select({ id: users.id, emailVerified: users.emailVerified })
        .from(users)
        .where(inArray(users.id, [...userIds]));
      const verifiedIds = new Set<string>();
      for (const row of rows) {
        if (row.emailVerified) verifiedIds.add(row.id);
      }
      return ok(verifiedIds);
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async isUserPending(userId) {
    try {
      const [row] = await db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!row) return err({ code: 'repo.not_found' });
      return ok(row.status === 'pending');
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async setFlagsInTx(tx, userId, flags) {
    try {
      const set: { emailVerified?: boolean; requiresPasswordReset?: boolean } = {};
      if (flags.emailVerified !== undefined) set.emailVerified = flags.emailVerified;
      if (flags.requiresPasswordReset !== undefined) {
        set.requiresPasswordReset = flags.requiresPasswordReset;
      }
      if (Object.keys(set).length === 0) return ok(undefined);

      const updated = await tx
        .update(users)
        .set(set)
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (updated.length === 0) return err({ code: 'repo.not_found' });
      return ok(undefined);
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },
};
