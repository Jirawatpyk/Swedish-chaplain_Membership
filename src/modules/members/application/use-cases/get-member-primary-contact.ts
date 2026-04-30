/**
 * T029 — F7 primary contact email lookup use-case (F3 module).
 *
 * Used by F7's `MembersBridgePort.getMemberPrimaryContact` (Phase 3+ T060).
 * Returns the primary-contact email of a member. Used by FR-002 precondition
 * `j` reply-to derivation — F7 uses this email as the broadcast `reply_to`.
 *
 * Returns `null` if:
 *   - the member has no primary contact (no `contacts` row with
 *     `is_primary = true AND removed_at IS NULL`)
 *   - the member is not found (caller decides whether to surface 404 or
 *     emit cross-tenant probe audit)
 */
import { runInTenant } from '@/lib/db';
import { err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';
import type { MemberRepo, RepoError } from '../ports/member-repo';

export type GetMemberPrimaryContactDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
};

export async function getMemberPrimaryContact(
  deps: GetMemberPrimaryContactDeps,
  memberId: MemberId,
): Promise<Result<string | null, RepoError>> {
  try {
    return await runInTenant(deps.tenant, async (tx) =>
      deps.memberRepo.findPrimaryContactEmailInTx(tx, memberId),
    );
  } catch (e) {
    return err({ code: 'repo.unexpected', cause: e });
  }
}
