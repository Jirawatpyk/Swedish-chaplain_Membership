/**
 * T029 — F7 segment resolution use-case (F3 module).
 *
 * Used by F7's `MembersBridgePort.getMembersBySegment` (Phase 3+ T060).
 * Resolves `all_members` and `tier:<codes>` segments. The
 * `event_attendees_last_90d` and `custom` segments are handled by F7's
 * own resolvers (`EventAttendeesRepository` stub + `validate-custom-recipients`)
 * — NOT this use-case.
 *
 * FR-015 + FR-015c + Q8: returns primary-contact email only; secondary
 * F3 contacts NOT included. Members with `broadcasts_halted_until_admin_review = true`
 * are excluded (Q14). Members with NULL primary email are returned but
 * with `primaryContactEmail: null` so caller can emit
 * `member_missing_primary_contact_email` audit + skip.
 *
 * Suppression filter (`marketing_unsubscribes`) is NOT applied here —
 * it belongs at F7's dispatch boundary per Q8 separation of concerns.
 */
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  F7MemberRecipient,
  MemberRepo,
  RepoError,
} from '../ports/member-repo';

export type GetMembersBySegmentDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
};

export type GetMembersBySegmentInput = {
  readonly segmentType: 'all_members' | 'tier';
  readonly tierCodes?: readonly string[];
};

export async function getMembersBySegment(
  deps: GetMembersBySegmentDeps,
  input: GetMembersBySegmentInput,
): Promise<Result<readonly F7MemberRecipient[], RepoError>> {
  return deps.memberRepo.findMembersBySegmentForBroadcast(deps.tenant, input);
}
