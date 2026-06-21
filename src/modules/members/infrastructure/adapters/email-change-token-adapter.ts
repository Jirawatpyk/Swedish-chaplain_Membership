/**
 * EmailChangeTokenPort adapter — FR-012a step (v) + (vi) persistence,
 * plus the FR-012b revert-flow lookups and consumption primitives.
 *
 * All writes go through the caller's transaction so the compound
 * operations in change-contact-email / verify / revert stay atomic.
 */

import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { err, ok } from '@/lib/result';
// Direct schema import — documented escape hatch for tx-sharing adapters.
import {
  emailChangeTokens,
  type EmailChangeTokenInsert,
} from '@/modules/auth/infrastructure/db/schema';
import type {
  ActiveToken,
  EmailChangeTokenPort,
  TokenType,
} from '../../application/ports/email-change-token-port';

export const emailChangeTokenAdapter: EmailChangeTokenPort = {
  async findActiveById(tokenId) {
    try {
      const [row] = await db
        .select()
        .from(emailChangeTokens)
        .where(
          and(
            eq(emailChangeTokens.id, tokenId),
            isNull(emailChangeTokens.consumedAt),
            gt(emailChangeTokens.expiresAt, sql`now()`),
          ),
        )
        .limit(1);
      if (!row) return err({ code: 'repo.not_found' });
      const active: ActiveToken = {
        tokenId: row.id,
        tenantId: row.tenantId,
        contactId: row.contactId,
        userId: row.userId,
        type: row.type as TokenType,
        oldEmail: row.oldEmail,
        newEmail: row.newEmail,
        activatedAt: row.activatedAt,
        expiresAt: row.expiresAt,
      };
      return ok(active);
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async insertInTx(tx, ctx, draft) {
    try {
      const insert: EmailChangeTokenInsert = {
        id: draft.tokenId,
        tenantId: ctx.slug,
        contactId: draft.contactId,
        userId: draft.userId,
        type: draft.type,
        oldEmail: draft.oldEmail,
        newEmail: draft.newEmail,
        activatedAt: draft.activatedAt,
        expiresAt: draft.expiresAt,
      };
      const [row] = await tx
        .insert(emailChangeTokens)
        .values(insert)
        .returning({ id: emailChangeTokens.id });
      if (!row) {
        return err({
          code: 'repo.unexpected',
          cause: 'email_change_tokens insert returned no row',
        });
      }
      return ok({ tokenId: row.id });
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async findActiveByIdInTx(tx, tokenId) {
    try {
      // FOR UPDATE prevents double-consume race under READ COMMITTED:
      // two concurrent requests cannot both pass the consumedAt IS NULL
      // check — the second blocks until the first commits/rolls back.
      const [row] = await tx
        .select()
        .from(emailChangeTokens)
        .where(
          and(
            eq(emailChangeTokens.id, tokenId),
            isNull(emailChangeTokens.consumedAt),
            gt(emailChangeTokens.expiresAt, sql`now()`),
          ),
        )
        .for('update')
        .limit(1);
      if (!row) return err({ code: 'repo.not_found' });
      const active: ActiveToken = {
        tokenId: row.id,
        tenantId: row.tenantId,
        contactId: row.contactId,
        userId: row.userId,
        type: row.type as TokenType,
        oldEmail: row.oldEmail,
        newEmail: row.newEmail,
        activatedAt: row.activatedAt,
        expiresAt: row.expiresAt,
      };
      return ok(active);
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async markConsumedInTx(tx, tokenId, consumedAt) {
    try {
      // Idempotent guard: only consume if not already consumed.
      // Combined with FOR UPDATE in findActiveByIdInTx, this is
      // belt-and-suspenders against double-consume.
      const updated = await tx
        .update(emailChangeTokens)
        .set({ consumedAt })
        .where(
          and(
            eq(emailChangeTokens.id, tokenId),
            isNull(emailChangeTokens.consumedAt),
          ),
        )
        .returning({ id: emailChangeTokens.id });
      if (updated.length === 0) {
        return err({ code: 'repo.not_found' });
      }
      return ok(undefined);
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async invalidateActiveForUserInTx(tx, userId, type, consumedAt) {
    try {
      const updated = await tx
        .update(emailChangeTokens)
        .set({ consumedAt })
        .where(
          and(
            eq(emailChangeTokens.userId, userId),
            eq(emailChangeTokens.type, type),
            isNull(emailChangeTokens.consumedAt),
            gt(emailChangeTokens.expiresAt, sql`now()`),
          ),
        )
        .returning({ id: emailChangeTokens.id });
      return ok({ invalidatedCount: updated.length });
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async invalidateAllActiveForUsersInTx(tx, userIds, consumedAt) {
    // Empty work-list → no-op (an empty inArray would otherwise produce a
    // degenerate `IN ()` SQL fragment in some drivers). Cheap guard, explicit.
    if (userIds.length === 0) return ok({ invalidatedEmails: [] });
    try {
      // One UPDATE over EVERY still-active token (any type) for the user set.
      // We intentionally do NOT filter `expires_at > now()`: an already-EXPIRED
      // unconsumed token is harmless (findActiveByIdInTx rejects it on expiry),
      // but stamping consumed_at on it too costs nothing and keeps the DPO-clean
      // invariant "no active token survives an erasure". RETURNING the old/new
      // emails lets the caller cancel the matching frozen-address outbox rows.
      const updated = await tx
        .update(emailChangeTokens)
        .set({ consumedAt })
        .where(
          and(
            inArray(emailChangeTokens.userId, [...userIds]),
            isNull(emailChangeTokens.consumedAt),
          ),
        )
        .returning({
          oldEmail: emailChangeTokens.oldEmail,
          newEmail: emailChangeTokens.newEmail,
        });
      const emails = new Set<string>();
      for (const row of updated) {
        if (row.oldEmail) emails.add(row.oldEmail);
        if (row.newEmail) emails.add(row.newEmail);
      }
      return ok({ invalidatedEmails: [...emails] });
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },
};
