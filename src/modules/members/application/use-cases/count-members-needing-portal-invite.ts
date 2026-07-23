/**
 * Chip count for the members directory (design doc §3.7). A thin pass-through
 * that exists so the presentation layer never touches a repo directly
 * (Principle III) and so the "same filter as the list" contract (D7) lives in
 * one place: callers hand in the SAME DirectoryOffsetFilter they gave the
 * search, and this forces `portalNeedsInvite` on.
 */
import { ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { DirectoryOffsetFilter, MemberRepo } from '../ports/member-repo';

export async function countMembersNeedingPortalInvite(
  deps: { readonly tenant: TenantContext; readonly memberRepo: MemberRepo },
  filter: DirectoryOffsetFilter & { readonly portalNeedsInvite: { readonly now: Date } },
): Promise<Result<number, never>> {
  const res = await deps.memberRepo.countMembersNeedingPortalInvite(
    deps.tenant,
    filter,
  );
  return ok(res.ok ? res.value : 0);
}
