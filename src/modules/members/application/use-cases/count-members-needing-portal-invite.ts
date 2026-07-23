/**
 * Chip count for the members directory (design doc §3.7). A thin pass-through
 * that exists so the presentation layer never touches a repo directly
 * (Principle III) and so the "same filter as the list" contract (D7) lives in
 * one place: callers hand in the SAME DirectoryOffsetFilter they gave the
 * search, and this forces `portalNeedsInvite` on.
 *
 * A repo failure is THROWN, never coerced to a number. Coercing `!ok` to `0`
 * would tell the chip "0 members need inviting" on a DB outage, which hides the
 * chip and reads as "everyone has been invited" — a lie. The caller
 * (`countMembersNeedingPortalInviteSafe` on the page) catches this throw and
 * degrades to `null`, which renders a disabled "unavailable" chip instead. Same
 * contract as the sibling `loadMembersPortalStatus` use case.
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
  if (!res.ok) {
    throw new Error(
      `countMembersNeedingPortalInvite failed: ${res.error.code}`,
    );
  }
  return ok(res.value);
}
