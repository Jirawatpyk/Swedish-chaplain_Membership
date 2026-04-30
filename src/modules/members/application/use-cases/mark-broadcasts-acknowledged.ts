/**
 * T029 — F7 mark-broadcasts-acknowledged use-case (F3 module).
 *
 * Used by F7's `MembersBridgePort.markBroadcastsAcknowledged`
 * (Phase 3+ T060). Q15 GDPR Art. 7 banner CTA — sets
 * `members.broadcasts_acknowledged_at = now()` (member self-service action).
 *
 * **Audit emission is NOT performed here** — F3 mutates the timestamp
 * column only; F7's caller emits `member_acknowledged_broadcasts_terms`
 * via F7's own audit-port + adapter (Phase 3+) on the
 * `previouslyNull == true` branch. The use-case returns
 * `previouslyNull` so the caller can decide whether to emit the audit
 * (idempotent — no double emit on already-acked members).
 */
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';
import type { MemberRepo, RepoError } from '../ports/member-repo';

export type MarkAckError =
  | RepoError
  | { code: 'mark_ack.member_not_found'; memberId: string };

export type MarkBroadcastsAcknowledgedDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
  readonly clock: { now(): Date };
};

export type MarkAckResult = {
  readonly acknowledgedAt: Date;
  readonly previouslyNull: boolean;
};

export async function markBroadcastsAcknowledged(
  deps: MarkBroadcastsAcknowledgedDeps,
  memberId: MemberId,
): Promise<Result<MarkAckResult, MarkAckError>> {
  try {
    return await runInTenant(deps.tenant, async (tx) => {
      const now = deps.clock.now();
      const updateResult =
        await deps.memberRepo.updateBroadcastsAcknowledgedAtInTx(
          tx,
          memberId,
          now,
        );
      if (!updateResult.ok) return err(updateResult.error);
      if (updateResult.value.affected === 0) {
        return err({
          code: 'mark_ack.member_not_found',
          memberId,
        });
      }
      return ok({
        acknowledgedAt: now,
        previouslyNull: updateResult.value.previouslyNull,
      });
    });
  } catch (e) {
    return err({ code: 'repo.unexpected', cause: e });
  }
}
