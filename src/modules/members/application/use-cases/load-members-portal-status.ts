/**
 * Members-directory batch read — portal state per member (design doc
 * 2026-07-23 §3.3). Mirrors `loadMembersMembershipStatus` (renewals), which
 * the same page already uses for the Lapsed/Suspended badges.
 *
 * ONE query per page, never per row. Two short-circuits avoid the round-trip
 * entirely: an empty page, and a page on which nobody is linked to a user.
 *
 * `now` is supplied by the CALLER and never read from a clock here, so the
 * badge and the needs-invite SQL filter judge expiry against the same instant
 * (design D8).
 *
 * A member absent from the returned map has NO primary contact. Absence never
 * means "the read failed" — the caller owns the degrade path and represents
 * failure as 'unknown', so a DB hiccup can never be rendered as "not invited".
 *
 * `Result<…, never>`: there is no domain error, only a thrown repo call, which
 * the caller catches.
 */
import { ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { derivePortalState, type PortalState } from '../../domain/portal-state';
import type { MemberId } from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';

export interface LoadMembersPortalStatusDeps {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
}

export interface LoadMembersPortalStatusInput {
  /**
   * The current directory page's members. CONTRACT: page-bounded (≤ a few
   * hundred) — this is per-page badge enrichment, not a bulk lookup.
   */
  readonly members: readonly {
    readonly memberId: string;
    readonly linkedUserId: string | null;
  }[];
  readonly now: Date;
}

export async function loadMembersPortalStatus(
  deps: LoadMembersPortalStatusDeps,
  input: LoadMembersPortalStatusInput,
): Promise<Result<ReadonlyMap<string, PortalState>, never>> {
  const result = new Map<string, PortalState>();
  const linked = input.members.filter((m) => m.linkedUserId !== null);

  for (const m of input.members) {
    if (m.linkedUserId === null) result.set(m.memberId, 'not_invited');
  }
  if (linked.length === 0) return ok(result);

  const pending = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
    deps.tenant,
    linked.map((m) => m.memberId as MemberId),
  );
  const byMember = new Map<string, Date>();
  if (pending.ok) {
    for (const row of pending.value) byMember.set(row.memberId, row.expiresAt);
  }

  for (const m of linked) {
    const expiresAt = byMember.get(m.memberId);
    result.set(
      m.memberId,
      derivePortalState({
        linkedUserId: m.linkedUserId,
        pendingInvitation: expiresAt ? { expiresAt } : null,
        now: input.now,
      }),
    );
  }
  return ok(result);
}
