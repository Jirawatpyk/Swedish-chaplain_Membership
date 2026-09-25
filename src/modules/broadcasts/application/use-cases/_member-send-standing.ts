/**
 * F119 T166 S-H1 — the member-side rules that block SENDING, read in one place.
 *
 * Spec § Edge Cases and `src/lib/lapsed-portal-scope.ts` rely on the rules
 * that block sending being re-applied after submit. Until T166 only
 * `submitBroadcast` applied them, so the minutes-long submit → approve edge —
 * and F119's 30-day approval round — let a member who was halted, or whose
 * membership lapsed, have an E-Blast approved and sent. The rules:
 *
 *   k. the halt flag — the member's broadcasts are halted pending admin
 *      review (complaint-rate auto-halt, Clarifications Q14);
 *   l. F8 membership access — a `suspended` or `terminated` member spends no
 *      E-Blast benefit (059-membership-suspension).
 *
 * `submitBroadcast`, `approveBroadcast` (approve-as-submitted),
 * `confirmSchedule`'s promotion (`member_approved → approved`) and BOTH
 * dispatch legs (`dispatchScheduledBroadcast`, `buildAudienceTick`) all read
 * them through `readMemberSendStanding`, so the five cannot drift apart.
 *
 * WHERE the gate runs — the three edges that make a row dispatchable, and
 * again at SEND time (F119 PR-A). An `approved` E-Blast scheduled days ahead
 * used to be sent even if the member was halted, suspended or lost coverage in
 * between — including by a refund or full credit note, which ends coverage
 * immediately since migration 0306 (#383). At dispatch the answer goes through
 * `_dispatch-standing-gate.ts`: a `suspended` membership is HELD (nothing sent,
 * the row stays `approved`, re-checked every tick); a halt or an ENDED
 * (`terminated`) membership is a PERMANENT refusal (`failed_to_dispatch`) —
 * the maintainer's rule. Mail a prior tick already handed to Resend is never
 * refused.
 *
 * Fail CLOSED, never open: a halt read that throws is `halt_read_failed`, an
 * access lookup error is `access_unavailable` — each caller turns both into a
 * server error, never into "in good standing".
 *
 * Pure Application — no framework imports.
 */
import type { TenantContext } from '@/modules/tenants';
import { errKind } from '@/lib/log-id';
import type { AuditEmitInput, F7AuditEventType } from '../ports/audit-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { MembershipAccessLookupError, MembershipAccessPort } from '../ports/membership-access-port';

/** The two reads, as every caller wires them. */
export interface MemberSendStandingDeps {
  readonly membersBridge: Pick<MembersBridgePort, 'getMembersHaltedInTenant'>;
  readonly membershipAccess: MembershipAccessPort;
}

export type MemberSendStanding =
  | { readonly kind: 'ok' }
  | { readonly kind: 'halted' }
  | { readonly kind: 'not_in_good_standing'; readonly access: 'suspended' | 'terminated' }
  /** The halt read threw — the gate was not decided (the error CLASS only). */
  | { readonly kind: 'halt_read_failed'; readonly errKind: string }
  /** The access lookup answered its error arm — the gate was not decided. */
  | { readonly kind: 'access_unavailable'; readonly errorKind: MembershipAccessLookupError['kind'] };

/**
 * T166 follow-up — the audit row a STAFF or DISPATCH refusal writes, under the
 * SAME event types submit's refusals use (`broadcast_member_halted_pending_review`,
 * `broadcast_membership_suspended_blocked`), so "why was this member's E-Blast
 * refused" is one query whichever surface refused it. `surface` tells the
 * edges apart. Ids only; `related_member_id`, never `member_id` — a staff or
 * system act is not member activity and must not fire the 0009
 * `last_activity_at` trigger (#336/#337); `actor_role` is the session role as
 * held (`?? null`) — `null` for the cron, which holds none.
 */
export interface StandingRefusalAuditInput {
  readonly refusal: 'halted' | 'not_in_good_standing';
  /** F119 PR-A — `dispatch` is either send leg (actor `system:cron`). */
  readonly surface: 'approve_as_submitted' | 'schedule_confirm' | 'dispatch';
  readonly tenantSlug: string;
  readonly memberId: string;
  readonly broadcastId: string;
  readonly actorUserId: string;
  readonly actorRole: string | null;
  readonly requestId: string | null;
}

/** The summary's verb per surface — a total map, so a new surface cannot fall into another's wording. */
const REFUSAL_VERB: Readonly<Record<StandingRefusalAuditInput['surface'], string>> = {
  approve_as_submitted: 'Approve',
  schedule_confirm: 'Schedule confirm',
  dispatch: 'Dispatch',
};

export function standingRefusalAuditEvent(input: StandingRefusalAuditInput): AuditEmitInput {
  const eventType: F7AuditEventType =
    input.refusal === 'halted' ? 'broadcast_member_halted_pending_review' : 'broadcast_membership_suspended_blocked';
  const verb = REFUSAL_VERB[input.surface];
  return {
    tenantId: input.tenantSlug,
    eventType,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    summary: `${verb} refused (${eventType}) for member ${input.memberId}`,
    payload: {
      related_member_id: input.memberId,
      broadcast_id: input.broadcastId,
      surface: input.surface,
      actor_role: input.actorRole ?? null,
    },
  };
}

/** The halt rule first, then membership access — the order submit has always applied. */
export async function readMemberSendStanding(
  deps: MemberSendStandingDeps,
  tenant: TenantContext,
  memberId: string,
): Promise<MemberSendStanding> {
  let halted: ReadonlyArray<{ readonly memberId: string }>;
  try {
    halted = await deps.membersBridge.getMembersHaltedInTenant(tenant);
  } catch (e) {
    return { kind: 'halt_read_failed', errKind: errKind(e) };
  }
  if (halted.some((h) => h.memberId === memberId)) return { kind: 'halted' };

  const access = await deps.membershipAccess.getMembershipAccess(tenant, memberId);
  if (!access.ok) return { kind: 'access_unavailable', errorKind: access.error.kind };
  if (access.value.access !== 'full') return { kind: 'not_in_good_standing', access: access.value.access };
  return { kind: 'ok' };
}
