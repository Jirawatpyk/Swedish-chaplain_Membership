/**
 * T029 — F7 set-member-halt use-case (F3 module).
 *
 * Used by F7's `MembersBridgePort.setMemberHalt` (Phase 3+ T060).
 * Q14 admin clear-halt action — toggles
 * `members.broadcasts_halted_until_admin_review` flag. Authz: admin role
 * only (manager role denied per FR-014).
 *
 * **Audit emission is NOT performed here** — F3 mutates the flag column
 * only; F7's caller emits `broadcast_member_dispatch_resumed`
 * (when halted=false) or `broadcast_member_halted_pending_review`
 * (when halted=true) via F7's own audit-port + adapter (Phase 3+).
 * This keeps F3's `audit_event_type` DB-enum writes free of F7-specific
 * literals and the F7 → F3 dependency direction clean.
 */
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';
import type { MemberRepo, RepoError } from '../ports/member-repo';

export type MemberHaltError =
  | RepoError
  | { code: 'member_halt.unauthorised'; actorRole: string }
  | { code: 'member_halt.member_not_found'; memberId: string };

export type SetMemberHaltDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
};

export type SetMemberHaltMeta = {
  readonly actorRole: 'admin' | 'manager' | 'member';
};

export async function setMemberHalt(
  deps: SetMemberHaltDeps,
  memberId: MemberId,
  halted: boolean,
  meta: SetMemberHaltMeta,
): Promise<Result<void, MemberHaltError>> {
  if (meta.actorRole !== 'admin') {
    return err({
      code: 'member_halt.unauthorised',
      actorRole: meta.actorRole,
    });
  }

  try {
    return await runInTenant(deps.tenant, async (tx) => {
      const updateResult = await deps.memberRepo.updateBroadcastsHaltedInTx(
        tx,
        memberId,
        halted,
      );
      if (!updateResult.ok) return err(updateResult.error);
      if (updateResult.value.affected === 0) {
        return err({
          code: 'member_halt.member_not_found',
          memberId,
        });
      }
      return ok(undefined as void);
    });
  } catch (e) {
    return err({ code: 'repo.unexpected', cause: e });
  }
}
