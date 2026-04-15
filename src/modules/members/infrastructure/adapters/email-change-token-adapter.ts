/**
 * EmailChangeTokenPort adapter — FR-012a step (v) + (vi) persistence,
 * plus the FR-012b revert-flow lookups and consumption primitives.
 *
 * All writes go through the caller's transaction so the compound
 * operations in change-contact-email / verify / revert stay atomic.
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
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
      await tx
        .update(emailChangeTokens)
        .set({ consumedAt })
        .where(eq(emailChangeTokens.id, tokenId));
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
};
