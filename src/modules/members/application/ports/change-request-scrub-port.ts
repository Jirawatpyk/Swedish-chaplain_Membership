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
  /**
   * The scrub. Its id read is `SELECT … FOR UPDATE` — the request rows are
   * the first lock the erase tx takes (the submit / decide order).
   */
  scrubForMemberInTx(
    tx: TenantTx,
    memberId: MemberId,
    at: Date,
  ): Promise<Result<ChangeRequestScrubResult, RepoError>>;

  /**
   * Every request id of the member, NON-locking — the erase use case calls
   * it AFTER the member row's `FOR UPDATE` and compares with
   * `scrubbedRequestIds`: a row the scrub's snapshot did not contain was
   * inserted by a submit that got in first (READ COMMITTED never adds rows
   * inserted after a statement started), and the erase aborts so a re-drive
   * scrubs it too (the seam re-review of PR-2). No lock, so no new AB-BA.
   */
  listRequestIdsInTx(tx: TenantTx, memberId: MemberId): Promise<Result<readonly ChangeRequestId[], RepoError>>;
}
