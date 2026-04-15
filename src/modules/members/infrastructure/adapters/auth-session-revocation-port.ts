/**
 * SessionRevocationPort adapter — T086.
 *
 * Runs `DELETE FROM sessions WHERE user_id = $1` under the caller's
 * transaction (for FR-012a atomicity). The grant `GRANT SELECT, DELETE
 * ON sessions TO chamber_app` is laid by migration 0012 so this
 * adapter works inside `runInTenant(...)`.
 *
 * Clean Architecture note: this adapter imports the sessions Drizzle
 * table directly rather than going through `@/modules/auth`. The F1
 * sessionRepo only exposes a non-tx `deleteByUserId(userId)` helper —
 * to share the transaction with the F3 atomic change-email path we
 * must issue the DELETE on the tx handle directly. Wrapping this in a
 * new F1 use case would add no behaviour.
 */

import { eq } from 'drizzle-orm';
import { err, ok } from '@/lib/result';
import { sessions } from '@/modules/auth/infrastructure/db/schema';
import type { SessionRevocationPort } from '../../application/ports/session-revocation-port';

export const authSessionRevocationPort: SessionRevocationPort = {
  async revokeAllForInTx(tx, userId, reason) {
    try {
      // `reason` is currently informational — behaviour is identical
      // across the two kinds. It is kept on the port to preserve the
      // audit payload slot for the US4 admin-force revoke flow.
      void reason;
      const deleted = await tx
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ id: sessions.id });
      return ok({ revokedCount: deleted.length });
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  // Stand-alone revocation (no caller tx) is NOT used by FR-012a — it
  // would be wired by the US4 admin-force revoke flow.
  async revokeAllFor() {
    return err({
      code: 'repo.unexpected',
      cause: 'revokeAllFor stand-alone path not wired yet (US4 admin-force)',
    });
  },
};
