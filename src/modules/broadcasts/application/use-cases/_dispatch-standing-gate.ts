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
 *                   cancelled / coverage ended, lapsed, refunded). The leg
 *                   deletes the row's draft first (spec 140 s1 ED4,
 *                   `deleteDraftBeforeRefusal`) but never stalls on it.
 *   - `refuse_erased` — spec 139: PERMANENT too, for a member who is erased.
 *                   (A requester NOT FOUND is `undecided` since review round 2,
 *                   P4: erasure never deletes a member row.) Its own kind because
 *                   it writes no standing-refusal audit row and sends the
 *                   member no email (P3), and because the leg must first
 *                   delete a pre-scrub draft the row still carries (P2,
 *                   `deleteDraftBeforeRefusal`). The `failure_reason`
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
import { isHandedStatus } from './_probe-refused-send';

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

/** The `undecided` message for a requester that is not in the tenant (P4). */
export const REQUESTER_NOT_FOUND = 'member_standing_requester_not_found';

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
      // Review round 2 (P4, maintainer 30 Oct 2026) — erasure never deletes a
      // member row, so a requester NOT FOUND is not evidence of an erasure:
      // refusing would delete the draft and end the row on a guess. Undecided
      // instead — nothing sent, nothing deleted, the row stays `approved`; the
      // runbook says how to find and cancel such a row by hand.
      return standing.missing === true
        ? { kind: 'undecided', message: REQUESTER_NOT_FOUND, errClass: 'requester_not_found' }
        : { kind: 'refuse_erased', reason: 'member_not_in_good_standing' };
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
 * What a refusal's DELETE of the row's never-handed draft decided.
 * `cleared` — the draft THIS ROW carries is gone, or can never be sent;
 * `draftOutcome` is what it found (`none` = the row carried no id). Other
 * copies are not this function's reach (RoPA residual 8d, below).
 * `undecided` — the draft may still be there. The erased arm then decides
 * nothing (`ERASED_DRAFT_NOT_DELETED`: nothing is sent, the row stays
 * `approved`, the next tick or the `reconcile-erasures` cascade tries again);
 * the halted / ended arm refuses anyway and records `undeleted` (spec 140 s1).
 */
export type DraftClearance =
  | { readonly kind: 'cleared'; readonly draftOutcome: 'none' | 'deleted' | 'absent' | 'cancelled' | 'failed' }
  /**
   * Review rounds 3 + 5 — carries the id it tried to DELETE, what the caller's
   * probe had read, and the thrown class (`errKind`, never a message), so the
   * CALLER writes the one log line for its final outcome.
   */
  | {
      readonly kind: 'undecided';
      readonly errClass: RefusedDraftErrClass;
      readonly resendBroadcastId: string;
      readonly probedStatus: 'draft' | 'cancelled' | null;
      readonly err: string | null;
    };

/**
 * Why a refusal's DELETE did not confirm — a CLOSED set (the DELETE's own
 * outcome kind, or `threw`), never the provider's text, so it may ride in an
 * append-only audit payload (`resendDraftErrClass`).
 */
export type RefusedDraftErrClass = 'forbidden' | 'retryable' | 'other' | 'threw';

/** The `dispatch.server_error` message of an erased refusal whose draft DELETE did not confirm. */
export const ERASED_DRAFT_NOT_DELETED = 'member_erased_draft_not_deleted';

/**
 * Before a dispatch leg refuses a row for the member's standing, delete the
 * Resend draft the row still carries — so a terminal row no longer keeps one.
 *
 * Spec 139 P2 (`refusal: 'erased'`): without it, an erasure cascade that
 * failed retryably (the next dispatch tick, every 5 min, reaches the gate
 * before `reconcile-erasures`, every 30 min) would make the row terminal and
 * leave the pre-scrub subject, body and from-name at Resend on that row's
 * draft. Spec 140 s1 ED4 (`refusal: 'standing'`): a halted or ENDED
 * membership's refusal did the same — the plain `refuse` arm was a producer
 * of terminal rows holding a draft (RoPA 8d).
 *
 * It closes the SEND and this row's draft, not every Resend copy: a minted
 * draft whose reclaim failed is on no row (RoPA residual 8d; slice 2 records
 * it). A terminal row's draft left behind (an undecided standing refusal, a
 * probed-refused send, a budget-exhausted or stuck import) is reached by the
 * erasure cascade's terminal-draft pass if the member is erased.
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
export async function deleteDraftBeforeRefusal(
  gateway: Pick<BroadcastsGatewayPort, 'deleteBroadcastOnce'>,
  ids: {
    readonly tenantId: string;
    readonly broadcastId: string;
    readonly leg: 'live' | 'import';
    readonly refusal: 'erased' | 'standing';
  },
  draft: { readonly resendBroadcastId: string; readonly probedStatus: 'draft' | 'cancelled' | null } | null,
): Promise<DraftClearance> {
  if (draft === null || draft.resendBroadcastId === '') return { kind: 'cleared', draftOutcome: 'none' };
  const logIds = { ...ids, resendBroadcastId: draft.resendBroadcastId, probedStatus: draft.probedStatus ?? 'not_found' };
  const undecided = { kind: 'undecided', resendBroadcastId: draft.resendBroadcastId, probedStatus: draft.probedStatus } as const;
  let outcome: DeleteBroadcastOnceOutcome['kind'];
  try {
    outcome = (await gateway.deleteBroadcastOnce(draft.resendBroadcastId)).kind;
  } catch (e) {
    // Review round 5 — no line here: the caller logs its final outcome once.
    return { ...undecided, errClass: 'threw', err: errKind(e) };
  }
  if (outcome === 'deleted' || outcome === 'absent') {
    logger.info({ ...logIds, outcome }, 'broadcasts.dispatch.refused_draft_deleted');
    return { kind: 'cleared', draftOutcome: outcome };
  }
  if (outcome === 'forbidden' && draft.probedStatus === 'cancelled') {
    logger.info({ ...logIds, outcome }, 'broadcasts.dispatch.refused_draft_cancelled_unsendable');
    return { kind: 'cleared', draftOutcome: 'cancelled' };
  }
  // Review rounds 4–5 (code-review #9) — no line here: the caller decides the
  // final outcome (a standing refusal probes a 403 first) and logs it once.
  return { ...undecided, errClass: outcome, err: null };
}

/**
 * Spec 140 s1 review round 5 — the one line an ERASED refusal writes when its
 * DELETE stays undecided. Ids, the Resend id, the closed class and the thrown
 * class only; never provider text.
 */
export function recordRefusedDraftUndecided(
  ids: { readonly tenantId: string; readonly broadcastId: string; readonly leg: 'live' | 'import'; readonly refusal: 'erased' | 'standing' },
  clearance: Extract<DraftClearance, { kind: 'undecided' }>,
): void {
  logger.warn(
    { ...ids, resendBroadcastId: clearance.resendBroadcastId, errClass: clearance.errClass, err: clearance.err },
    'broadcasts.dispatch.refused_draft_delete_unconfirmed',
  );
}

/**
 * What a halted / ended refusal's DELETE decided (spec 140 s1 ED4). `handed` —
 * a sibling tick sent the draft between this tick's probe and its DELETE: the
 * mail is out, so the leg writes no `failed_to_dispatch`, emails nobody and
 * answers a concurrent skip. `undeleted` — the refusal goes ahead and records
 * `resendDraftOutcome: 'undeleted'` + `resendDraftErrClass`.
 */
export type StandingDraftClearance =
  | Extract<DraftClearance, { kind: 'cleared' }>
  | { readonly kind: 'undeleted'; readonly errClass: StandingDraftErrClass }
  | { readonly kind: 'handed'; readonly resendStatus: 'queued' | 'sending' | 'sent' };

/**
 * Spec 140 s1 review round 2 (code-review #6) — why a standing refusal's draft
 * stayed, as a CLOSED set for `resendDraftErrClass`: the DELETE's own answer
 * (`retryable` / `other` / `threw`), or, after a 403, what the one GET read
 * (`probe_*`, `threw`). Never the provider's text.
 */
export type StandingDraftErrClass =
  | Exclude<RefusedDraftErrClass, 'forbidden'>
  | 'probe_draft'
  | 'probe_not_found'
  | 'probe_retryable'
  | 'probe_other';

/**
 * Spec 140 s1 review round 1 (reliability M-1, code-review #4, security L2) —
 * `deleteDraftBeforeRefusal` for the plain refusal. A 403 on a draft the probe
 * did not call `cancelled` is either a restricted key or a sibling tick that
 * has just sent it; refusing the second would record `failed_to_dispatch`,
 * release the quota slot and tell the member a delivered E-Blast failed. So ONE
 * bounded `retrieveBroadcastOnce` decides: queued / sending / sent → `handed`;
 * anything else (a throw included) → `undeleted`, and the refusal goes ahead.
 */
export async function deleteDraftBeforeStandingRefusal(
  gateway: Pick<BroadcastsGatewayPort, 'deleteBroadcastOnce' | 'retrieveBroadcastOnce'>,
  ids: { readonly tenantId: string; readonly broadcastId: string; readonly leg: 'live' | 'import' },
  draft: { readonly resendBroadcastId: string; readonly probedStatus: 'draft' | 'cancelled' | null } | null,
): Promise<StandingDraftClearance> {
  const cleared = await deleteDraftBeforeRefusal(gateway, { ...ids, refusal: 'standing' }, draft);
  if (cleared.kind === 'cleared') return cleared;
  // Review round 5 — ONE line per refusal, for its final outcome, carrying the
  // tick's first probe, the DELETE's answer and (after a 403) the GET's reading.
  const { resendBroadcastId } = cleared;
  const logIds = {
    ...ids,
    refusal: 'standing',
    resendBroadcastId,
    probedStatus: cleared.probedStatus ?? 'not_found',
    outcome: cleared.errClass,
  };
  // Only a 403 can hide a sibling's send; `cleared` above already took a 403 on
  // a `cancelled` id.
  if (cleared.errClass !== 'forbidden') {
    logger.warn(
      { ...logIds, observedResendStatus: null, errClass: cleared.errClass, err: cleared.err },
      'broadcasts.dispatch.refused_draft_delete_unconfirmed',
    );
    return { kind: 'undeleted', errClass: cleared.errClass };
  }
  let probe: Awaited<ReturnType<BroadcastsGatewayPort['retrieveBroadcastOnce']>>;
  try {
    probe = await gateway.retrieveBroadcastOnce(resendBroadcastId);
  } catch (e) {
    logger.warn({ ...logIds, observedResendStatus: null, errClass: 'threw', err: errKind(e) }, 'broadcasts.dispatch.refused_draft_delete_unconfirmed');
    return { kind: 'undeleted', errClass: 'threw' };
  }
  const probed = probe.kind === 'present' ? probe.status : probe.kind;
  if (isHandedStatus(probed)) {
    logger.warn({ ...logIds, observedResendStatus: probed }, 'broadcasts.dispatch.refused_draft_handed_by_sibling');
    return { kind: 'handed', resendStatus: probed };
  }
  // Review round 2 (code-review #6) — a `cancelled` reading is an unsendable
  // copy: cleared, as `deleteDraftBeforeRefusal` clears a 403 on an id its
  // probe already called cancelled. Review round 3 (code-review #4) — so is
  // `failed` (MEASURED 2026-10-29: only a draft can be sent): cleared, and
  // recorded as `failed` (`resendDraftOutcome`), not as an undeleted draft.
  if (probed === 'cancelled' || probed === 'failed') {
    logger.info({ ...logIds, observedResendStatus: probed }, 'broadcasts.dispatch.refused_draft_cancelled_unsendable');
    return { kind: 'cleared', draftOutcome: probed };
  }
  const errClass = PROBE_ERR_CLASS[probed] ?? 'probe_other';
  logger.warn({ ...logIds, observedResendStatus: probed, errClass }, 'broadcasts.dispatch.refused_draft_delete_unconfirmed');
  return { kind: 'undeleted', errClass };
}

/** What a non-handed, non-cancelled GET after a 403 is recorded as; anything else is `probe_other`. */
const PROBE_ERR_CLASS: Readonly<Record<string, StandingDraftErrClass>> = {
  draft: 'probe_draft',
  not_found: 'probe_not_found',
  retryable: 'probe_retryable',
};

/**
 * Spec 139 P4 — the warn line a leg writes when the requester is not in the
 * tenant (`REQUESTER_NOT_FOUND`). Ids only. Written by the legs, not by
 * `decideDispatchStanding`, so the staff detail page's read stays quiet; the
 * cron also counts it under `dispatchResolveFailedTotal{phase=standing}`.
 */
export function recordRequesterNotFound(tenantSlug: string, broadcastId: string, leg: 'live' | 'import'): void {
  logger.warn({ tenantId: tenantSlug, broadcastId, leg }, 'broadcasts.dispatch.requester_not_found');
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
