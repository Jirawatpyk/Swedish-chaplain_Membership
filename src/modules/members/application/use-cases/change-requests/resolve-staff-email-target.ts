/**
 * F114 T120 (post-ship `/code-review` 2026-09-16, finding #1) — which request
 * a queued `member_change_request_submitted_staff` outbox row should render.
 *
 * FR-011 coalesces the staff email: a resubmit within 1 h of the last
 * notification INHERITS `staff_notified_at` and queues NO row of its own, so
 * reviewers get one email per submitter per hour instead of one per keystroke.
 * The dispatcher then found the queued row's request `withdrawn / replaced`
 * and skipped it as `request_superseded` — correct when the replacement queued
 * its OWN row, and a DROPPED email when it coalesced. Nobody was told until
 * the next submission an hour later.
 *
 * The rule: follow `replacedByRequestId` to the pending head and render THAT
 * (the email's deep link opens the current values — SC-013), but only when the
 * head INHERITED this row's `staffNotifiedAt`. That equality is exactly
 * "coalesced, so no row of its own": a replacement past the window stamps its
 * own time and has its own row, and rendering it here would send the reviewer
 * a second, identical email.
 *
 * Anything else stays `request_superseded`: a request withdrawn by the member,
 * a decided one, a chain that dead-ends. Application layer — the loader is a
 * function, so the whole decision is unit-testable without a database.
 */
import type { Result } from '@/lib/result';
import type { ChangeRequest, ChangeRequestId } from '../../../domain/change-request/change-request';
import type { RepoError } from '../../ports/member-repo';

export type StaffEmailTarget =
  /** Render this request for the queued row. */
  | { readonly kind: 'render'; readonly request: ChangeRequest }
  /** A permanent, SILENT skip — the reviewer is reached (or was) some other way. */
  | { readonly kind: 'superseded' }
  /** The request rows are gone (hard-deleted) — a permanent, AUDITED failure. */
  | { readonly kind: 'gone' }
  /** A transient repo fault — the row must stay on the retry ladder. */
  | { readonly kind: 'fault' };

/**
 * A replace chain is one hop per resubmit inside the window; ten is far past
 * anything the FR-008 cap allows in an hour, and it is the guard against a
 * cyclic `replaced_by_request_id` turning a cron tick into an infinite loop.
 */
export const MAX_REPLACEMENT_HOPS = 10;

export async function resolveStaffEmailTarget(
  queued: ChangeRequest,
  load: (id: ChangeRequestId) => Promise<Result<ChangeRequest, RepoError>>,
): Promise<StaffEmailTarget> {
  if (queued.state === 'pending') return { kind: 'render', request: queued };
  // withdrawn by the member, closed by an erasure, or decided: the reviewer
  // has nothing to act on and the replacement (if any) is someone else's row
  if (queued.state !== 'withdrawn' || queued.withdrawnReason !== 'replaced') return { kind: 'superseded' };
  // a row is only ever queued when the submit NOTIFIED, so a queued row whose
  // request carries no timestamp is not a coalescing chain we can reason about
  if (queued.staffNotifiedAt === null) return { kind: 'superseded' };

  let current = queued;
  for (let hop = 0; hop < MAX_REPLACEMENT_HOPS; hop += 1) {
    const nextId = current.replacedByRequestId;
    if (nextId === null) return { kind: 'superseded' };
    const next = await load(nextId);
    if (!next.ok) return next.error.code === 'repo.not_found' ? { kind: 'gone' } : { kind: 'fault' };
    const head = next.value;
    if (head.state === 'pending') {
      // the head INHERITED this row's stamp ⇒ it coalesced ⇒ it has no outbox
      // row of its own ⇒ this row is the only email the reviewer will get
      return head.staffNotifiedAt !== null && head.staffNotifiedAt.getTime() === queued.staffNotifiedAt.getTime()
        ? { kind: 'render', request: head }
        : { kind: 'superseded' };
    }
    if (head.state !== 'withdrawn' || head.withdrawnReason !== 'replaced') return { kind: 'superseded' };
    current = head;
  }
  return { kind: 'superseded' };
}
