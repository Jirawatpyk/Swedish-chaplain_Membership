/**
 * Review 2026-09-07 (108 PR-C, FR-022a) — the address-level count of LIVE
 * contacts of the segment's ELIGIBLE members that opted out of marketing.
 *
 * `getBroadcastRecipientContacts` excludes those contacts in SQL (the 0294
 * predicate), so the F7 resolver never sees the addresses and its own step-5b
 * filter measures 0 on the all_contacts leg. This count is what it adds to
 * `droppedByPreference`, so the sender is told the true number of people who
 * objected instead of a structural zero. Pass-through to the repo; the
 * behaviour is pinned live in
 * `tests/integration/members/broadcast-recipient-contacts-keyset.test.ts`.
 */
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastOptedOutCountQuery, MemberRepo, RepoError } from '../ports/member-repo';

export type CountBroadcastOptedOutContactsDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
};

export type CountBroadcastOptedOutContactsInput = BroadcastOptedOutCountQuery;

export async function countBroadcastOptedOutContacts(
  deps: CountBroadcastOptedOutContactsDeps,
  input: CountBroadcastOptedOutContactsInput,
): Promise<Result<number, RepoError>> {
  return deps.memberRepo.countBroadcastOptedOutContacts(deps.tenant, input);
}
