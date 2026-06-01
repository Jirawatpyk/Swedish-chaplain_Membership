/**
 * deleteInvitedUserPortAdapter — adapts F1 `deleteInvitedUser` to the narrowed
 * `DeleteInvitedUserPort` that `invitePortal` depends on for SAGA compensation
 * (go-live #12-13).
 *
 * When the contact-link step fails AFTER F1 `createUser` committed, `invitePortal`
 * calls this to ROLL BACK the just-created pending user (+ its FK-cascaded
 * invitation + queued invite email) so no orphan persists. The port reports only
 * `{ ok }` — `invitePortal` returns `link_failed` regardless of whether the
 * compensation succeeded (a compensation failure leaves a *logged* orphan, which
 * is the rare-of-rare residual). `ok: false` here means the rollback itself
 * faulted; the caller logs but still surfaces `link_failed`.
 *
 * Infrastructure layer — may import `@/modules/auth` (composition glue).
 */
import { deleteInvitedUser as f1DeleteInvitedUser } from '@/modules/auth';
import type { DeleteInvitedUserPort } from '../../application/use-cases/invite-portal';

export const deleteInvitedUserPortAdapter: DeleteInvitedUserPort = async (input) => {
  const result = await f1DeleteInvitedUser({
    // F1 takes a branded UserId; at the boundary we pass the raw id through.
    // Safe because deleteInvitedPendingInTx matches by exact id + status='pending',
    // so a malformed/stale id simply deletes 0 rows (a benign no-op).
    userId: input.userId as never,
    outboxRowId: input.outboxRowId,
    actorUserId: input.actorUserId,
    sourceIp: input.sourceIp,
    requestId: input.requestId,
    targetEmail: input.targetEmail,
  });
  return { ok: result.ok };
};
