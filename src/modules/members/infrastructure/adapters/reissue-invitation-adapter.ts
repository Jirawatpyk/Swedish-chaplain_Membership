/**
 * ReissueInvitationPort adapter — delegates to the F1 `reissueInvitation`
 * use-case (owner-role mint + outbox enqueue in its own transaction).
 *
 * Single allowed crossing point between the F3 `resendBouncedInvite`
 * use-case and the F1 invitation surface (Constitution Principle III).
 * The adapter brands the plain string ids at the boundary and maps the
 * F1 typed error union onto the port's error union.
 *
 * NOTE: there is intentionally NO `tx` parameter — the F1 use-case owns
 * its own owner-role `db.transaction`. chamber_app has no INSERT grant on
 * `invitations` (migrations 0016/0017; 0183 transiently GRANTed INSERT and
 * 0184 REVOKEd it — net grant is still none), so the mint MUST run in the
 * owner role, exactly like `createUser`.
 *
 * Result-contract boundary: `reissueInvitation` re-throws unexpected
 * (non-`TxAbort`) errors (Neon drop, deadlock). This adapter catches them
 * and converts to a typed `reissue_failed` err — the port contract is
 * Result-returning and MUST NOT throw, so the F3 use-case can map it to a
 * clean `server_error` 500 instead of letting it escape the route.
 */

import { err, ok } from '@/lib/result';
import { asUserId } from '@/modules/auth/domain/branded';
import { reissueInvitation } from '@/modules/auth/application/reissue-invitation';
import type { ReissueInvitationPort } from '../../application/ports/reissue-invitation-port';

export const reissueInvitationAdapter: ReissueInvitationPort = {
  async reissue(input) {
    let result: Awaited<ReturnType<typeof reissueInvitation>>;
    try {
      result = await reissueInvitation({
        userId: asUserId(input.userId),
        invitedByUserId: asUserId(input.invitedByUserId),
        locale: input.locale,
        tenantId: input.tenantId,
        requestId: input.requestId,
      });
    } catch (e) {
      return err({ code: 'reissue_failed', cause: e });
    }

    if (result.ok) {
      return ok({ invitationId: result.value.invitationId as string });
    }

    switch (result.error.code) {
      case 'user-not-found':
        return err({ code: 'user_not_found' });
      case 'not-pending':
        return err({ code: 'not_pending' });
      case 'reissue-failed':
        return err({ code: 'reissue_failed' });
      default: {
        // Exhaustiveness guard: a new F1 error code becomes a compile
        // error here instead of silently falling through to ok(undefined).
        const exhaustive: never = result.error;
        return err({ code: 'reissue_failed', cause: exhaustive });
      }
    }
  },
};
