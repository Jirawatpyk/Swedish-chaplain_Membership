/**
 * F119 PR-A — the member-standing decision at SEND time, shared by both
 * dispatch legs (`dispatchScheduledBroadcast`, `buildAudienceTick`) so the two
 * cannot drift: each used to carry its own copy of the same switch.
 *
 * It reads the standing through `readMemberSendStanding` (the one reader
 * submit, approve-as-submitted and the promotion share) and turns it into what
 * a dispatch tick does next:
 *
 *   - `send`      — in good standing; the leg carries on.
 *   - `hold`      — the membership is `suspended` (F8: `awaiting_payment`,
 *                   `pending_admin_reactivation`, or an unpaid period that has
 *                   ended). The maintainer's rule (R1): NOT a refusal. Suspension
 *                   is recoverable by paying, and before #397 F8 even suspended a
 *                   member whose renewal bill was issued early while the current
 *                   period was still paid — refusing there killed E-Blasts of
 *                   members in good faith. Held:
 *                   nothing is sent and the only write is the FR-021 retry-clock
 *                   reset (F119 PR-E) — no audit, no email; the row stays
 *                   `approved`, and
 *                   every tick asks again — it sends once the cycle completes
 *                   (possibly after `scheduled_for`), and is refused once the
 *                   cycle lapses (`terminated`).
 *   - `refuse`    — PERMANENT (`failed_to_dispatch`): the member's E-Blasts are
 *                   halted, or the membership has ENDED (F8 `terminated`:
 *                   cancelled / coverage ended, lapsed, refunded).
 *   - `refuse_erased` — spec 139: PERMANENT too, for a member who is erased or
 *                   no longer exists in the tenant (P4). Its own kind because
 *                   it writes no standing-refusal audit row and sends the
 *                   member no email (P3), and because the leg must first
 *                   delete a pre-scrub draft the row still carries (P2,
 *                   `deleteErasedDraftBeforeRefusal`). The `failure_reason`
 *                   token is the existing `member_not_in_good_standing`.
 *   - `undecided` — a read failed, or answered something this build does not
 *                   know. Fail CLOSED: nothing is sent, the row stays
 *                   `approved`, the leg answers `dispatch.server_error` (phase
 *                   `standing`) and the next tick asks again.
 *
 * R2 — a `halted` answer is re-read UNCACHED before it becomes a permanent
 * refusal. The cron memoises the tenant's halt list per tick
 * (`tick-memoized-members-bridge.ts`), so a halt an admin cleared mid-tick still
 * read as halted for every later row of that tick, and the refusal is
 * irreversible. One extra read, paid only on the way to a refusal.
 *
 * Pure Application — no framework imports.
 */
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastsGatewayPort, DeleteBroadcastOnceOutcome } from '../ports/broadcasts-gateway-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { StandingRefusalFailureReason } from '../../domain/value-objects/standing-refusal-failure-reason';
import { readMemberSendStanding, type MemberSendStandingDeps, type StandingRefusal } from './_member-send-standing';

/** The standing reads a dispatch leg makes. */
export interface DispatchStandingDeps extends MemberSendStandingDeps {
  /**
   * R2 — the UNMEMOISED halt read, consulted only before a permanent `halted`
   * refusal. A composition that memoises `membersBridge` (the cron does, per
   * tick) MUST set it to the raw bridge; absent, `membersBridge` itself is
   * re-read, which is only fresh when it is not memoised.
   */
  readonly haltReadFresh?: Pick<MembersBridgePort, 'getMemberErasedAt' | 'getMembersHaltedInTenant'>;
}

export type DispatchStandingDecision =
  | { readonly kind: 'send' }
  | { readonly kind: 'hold' }
  | {
      readonly kind: 'refuse';
      /** Which refusal audit row (`standingRefusalAuditEvent`) to write — the standing itself, so the row names its `access`. */
      readonly refusal: StandingRefusal;
      /** The member-facing / `failure_reason` token (kept by the erasure scrub). */
      readonly reason: StandingRefusalFailureReason;
    }
  | { readonly kind: 'refuse_erased'; readonly reason: Extract<StandingRefusalFailureReason, 'member_not_in_good_standing'> }
  | { readonly kind: 'undecided'; readonly message: string; readonly errClass: string };

export async function decideDispatchStanding(
  deps: DispatchStandingDeps,
  tenant: TenantContext,
  memberId: string,
): Promise<DispatchStandingDecision> {
  let standing = await readMemberSendStanding(deps, tenant, memberId);
  if (standing.kind === 'halted') {
    // R2 — refuse only on a FRESH halt. The re-read goes through the whole
    // reader, so a cleared halt falls through to the F8 access check it
    // short-circuited the first time.
    standing = await readMemberSendStanding(
      { membersBridge: deps.haltReadFresh ?? deps.membersBridge, membershipAccess: deps.membershipAccess },
      tenant,
      memberId,
    );
  }
  switch (standing.kind) {
    case 'ok':
      return { kind: 'send' };
    case 'erased':
      return { kind: 'refuse_erased', reason: 'member_not_in_good_standing' };
    case 'halted':
      return { kind: 'refuse', refusal: standing, reason: 'member_halted' };
    case 'not_in_good_standing':
      return standing.access === 'suspended'
        ? { kind: 'hold' }
        : { kind: 'refuse', refusal: standing, reason: 'member_not_in_good_standing' };
    case 'erasure_read_failed':
      return { kind: 'undecided', message: 'member_standing_erasure_read_failed', errClass: standing.errKind };
    case 'halt_read_failed':
      return { kind: 'undecided', message: 'member_standing_halt_read_failed', errClass: standing.errKind };
    case 'access_unavailable':
      return { kind: 'undecided', message: 'member_standing_access_unavailable', errClass: standing.errorKind };
    default: {
      // `void`, never `return _exhaustive` (fail-open at runtime). An unknown
      // answer did not decide the gate, so nothing is sent.
      const _exhaustive: never = standing;
      void _exhaustive;
      return { kind: 'undecided', message: 'member_standing_unrouted', errClass: 'gate' };
    }
  }
}

/**
 * What an erased refusal's DELETE of the row's pre-scrub draft decided (P2).
 * `cleared` — nothing of the member's is left at Resend that `/send` could
 * still accept, so the leg may refuse terminally; `draftOutcome` is what it
 * found (`none` = the row carried no id). `undecided` — the draft may still
 * be there: nothing is sent, the row stays `approved`, the next tick (or the
 * `reconcile-erasures` cron's cascade) tries again.
 */
export type ErasedDraftClearance =
  | { readonly kind: 'cleared'; readonly draftOutcome: 'none' | 'deleted' | 'absent' | 'cancelled' }
  | { readonly kind: 'undecided'; readonly message: 'member_erased_draft_not_deleted'; readonly errClass: string };

/**
 * Spec 139 P2 — before an erased member's row is refused, delete the Resend
 * draft it still carries. Without this, an erasure cascade that failed
 * retryably (the next dispatch tick, every 5 min, reaches the gate before
 * `reconcile-erasures`, every 30 min) would make the row terminal and leave
 * the pre-scrub subject, body and from-name at Resend for good.
 *
 * Called only for an id the same tick's probe said was never handed to
 * `/send` (`draft`, `cancelled`, or `not_found`) — a handed id never reaches
 * the gate. One `deleteBroadcastOnce`: `deleted` / `absent` clear; `forbidden`
 * clears ONLY when the probe said `cancelled` (Resend answers 403 to a DELETE
 * of a cancelled broadcast, and a cancelled broadcast can never be sent — only
 * a draft can, MEASURED 2026-10-29 — so refusing it cannot strand a send;
 * without this arm such a row would be undecided on every tick for ever). Any
 * other answer, or a throw, is `undecided`.
 *
 * Kept OUT of `decideDispatchStanding`, which the staff detail page reads
 * (`read-dispatch-hold.ts`): a page read must never delete anything.
 */
export async function deleteErasedDraftBeforeRefusal(
  gateway: Pick<BroadcastsGatewayPort, 'deleteBroadcastOnce'>,
  ids: { readonly tenantId: string; readonly broadcastId: string; readonly leg: 'live' | 'import' },
  draft: { readonly resendBroadcastId: string; readonly probedStatus: 'draft' | 'cancelled' | null } | null,
): Promise<ErasedDraftClearance> {
  if (draft === null || draft.resendBroadcastId === '') return { kind: 'cleared', draftOutcome: 'none' };
  const logIds = { ...ids, resendBroadcastId: draft.resendBroadcastId, probedStatus: draft.probedStatus ?? 'not_found' };
  let outcome: DeleteBroadcastOnceOutcome['kind'];
  try {
    outcome = (await gateway.deleteBroadcastOnce(draft.resendBroadcastId)).kind;
  } catch (e) {
    logger.warn({ ...logIds, err: errKind(e) }, 'broadcasts.dispatch.erased_draft_delete_threw');
    return { kind: 'undecided', message: 'member_erased_draft_not_deleted', errClass: 'threw' };
  }
  if (outcome === 'deleted' || outcome === 'absent') {
    logger.info({ ...logIds, outcome }, 'broadcasts.dispatch.erased_draft_deleted');
    return { kind: 'cleared', draftOutcome: outcome };
  }
  if (outcome === 'forbidden' && draft.probedStatus === 'cancelled') {
    logger.info({ ...logIds, outcome }, 'broadcasts.dispatch.erased_draft_cancelled_unsendable');
    return { kind: 'cleared', draftOutcome: 'cancelled' };
  }
  logger.warn({ ...logIds, outcome }, 'broadcasts.dispatch.erased_draft_delete_unconfirmed');
  return { kind: 'undecided', message: 'member_erased_draft_not_deleted', errClass: outcome };
}

/**
 * The hold's only trace. Deliberately NOT an audit row: a held E-Blast is
 * re-checked every 5 minutes, so a row per tick would bury the log. Ids only —
 * no member id, no address, no F8 reason.
 */
export function recordDispatchHold(tenantSlug: string, broadcastId: string, leg: 'live' | 'import'): void {
  logger.info({ tenantId: tenantSlug, broadcastId, leg }, 'broadcasts.dispatch.standing_held');
  broadcastsMetrics.dispatchStandingHeldTotal(tenantSlug);
}
