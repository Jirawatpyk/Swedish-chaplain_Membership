/**
 * F114 FR-030 / research R10 — erasure scrub of a member's change requests.
 *
 * Called by `eraseMember` INSIDE step 2 (the atomic scrub tx): every request
 * row of the member gets `seen_value` / `proposed_value` / `decision_reason`
 * / `decision_note` replaced with the erasure sentinel, and any `pending`
 * request is closed `withdrawn / erasure` (system actor). Row counts and
 * outcomes remain — the existence of decided requests is part of the
 * accountability record.
 */
import type { TenantTx } from '@/lib/db';
import type { Result } from '@/lib/result';
import type { ChangeRequestId, ChangeRequestScope } from '../../domain/change-request/change-request';
import type { ContactId } from '../../domain/contact';
import type { MemberId } from '../../domain/member';
import type { RepoError } from './member-repo';

/** A request that was still pending and is now `withdrawn / erasure` — what its closure audit row needs. */
export type ClosedChangeRequest = {
  readonly id: ChangeRequestId;
  readonly contactId: ContactId;
  readonly scope: ChangeRequestScope;
};

export type ChangeRequestScrubResult = {
  /** Every request of the member that was scrubbed (rows kept). */
  readonly scrubbedRequestIds: readonly ChangeRequestId[];
  /** The subset that was still pending and is now `withdrawn / erasure` (the erase use case audits each). */
  readonly closedRequests: readonly ClosedChangeRequest[];
};

export interface ChangeRequestScrubPort {
  scrubForMemberInTx(
    tx: TenantTx,
    memberId: MemberId,
    at: Date,
  ): Promise<Result<ChangeRequestScrubResult, RepoError>>;
}
