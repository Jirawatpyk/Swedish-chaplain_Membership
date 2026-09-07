/**
 * 108 PR-C T074 — one keyset page of broadcast recipient CONTACTS (F3 side of
 * US3, FR-020–FR-022, FR-029).
 *
 * Consumed by F7's `MembersBridgePort.getContactsBySegment`, which loops
 * pages until an empty one and PROPAGATES a failed page (research R8: an
 * adapter answering `[]` on error is a second silent-truncation vector under
 * pagination). Pure pass-through, like `getMembersBySegment`: every rule that
 * decides eligibility is in `MemberRepo.findBroadcastRecipientContacts`'s SQL
 * and is proved on live Neon by
 * `tests/integration/members/broadcast-recipient-contacts-keyset.test.ts`.
 *
 * Suppression (`marketing_unsubscribes`), sender self-exclusion, dedupe and
 * the ceiling remain F7's (`resolveSegmentRecipients`) — Q8 separation of
 * concerns, unchanged.
 */
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  BroadcastRecipientContactsQuery,
  F7ContactRecipient,
  MemberRepo,
  RepoError,
} from '../ports/member-repo';

export type GetBroadcastRecipientContactsDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
};

export type GetBroadcastRecipientContactsInput = BroadcastRecipientContactsQuery;

export async function getBroadcastRecipientContacts(
  deps: GetBroadcastRecipientContactsDeps,
  input: GetBroadcastRecipientContactsInput,
): Promise<Result<readonly F7ContactRecipient[], RepoError>> {
  return deps.memberRepo.findBroadcastRecipientContacts(deps.tenant, input);
}
