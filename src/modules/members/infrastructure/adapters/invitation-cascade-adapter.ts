/**
 * InvitationCascadePort adapter — soft-consumes pending F1 invitations
 * for a set of user ids inside the caller's tx.
 *
 * Single allowed crossing point between F3 archive-member use case and
 * the cross-module F1 `invitations` table (Principle III). The adapter
 * preserves the R001 column-grant constraint — `invitations.id` is the
 * raw invite token and migration 0017 revokes SELECT on that column
 * from `chamber_app`. We use `.returning({ userId })` only, NEVER
 * `{ id }`.
 *
 * Cross-module justification: the F1 `tokenRepo` only exposes non-tx
 * helpers; to share the archive-member tx we must issue the UPDATE on
 * the tx handle directly. Same pattern as `authSessionRevocationPort`.
 */

import { and, inArray, isNull, sql } from 'drizzle-orm';
import { invitations } from '@/modules/auth/infrastructure/db/schema';
import type { InvitationCascadePort } from '../../application/ports/invitation-cascade-port';

export const drizzleInvitationCascadePort: InvitationCascadePort = {
  async softConsumePendingForUsersInTx(tx, userIds, now) {
    if (userIds.length === 0) {
      return { revokedCount: 0 };
    }
    const revokedRows = await tx
      .update(invitations)
      .set({ consumedAt: now })
      .where(
        and(
          inArray(invitations.userId, [...userIds]),
          isNull(invitations.consumedAt),
          sql`${invitations.expiresAt} > NOW()`,
        ),
      )
      .returning({ userId: invitations.userId });
    return { revokedCount: revokedRows.length };
  },
};
