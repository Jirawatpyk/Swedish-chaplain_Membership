/**
 * T029 — F7 halted-members list use-case (F3 module).
 *
 * Used by F7's `MembersBridgePort.getMembersHaltedInTenant` (Phase 3+ T060).
 * Q14 admin queue red banner: lists all members with
 * `broadcasts_halted_until_admin_review = true` so admin can review +
 * clear the halt via `setMemberHalt(memberId, false)`.
 */
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  F7MemberHaltSummary,
  MemberRepo,
  RepoError,
} from '../ports/member-repo';

export type GetMembersHaltedInTenantDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
};

export async function getMembersHaltedInTenant(
  deps: GetMembersHaltedInTenantDeps,
): Promise<Result<readonly F7MemberHaltSummary[], RepoError>> {
  return deps.memberRepo.findMembersHaltedForBroadcast(deps.tenant);
}
