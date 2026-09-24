/**
 * F119 T166 S-H1 — the member-side rules that block SENDING, read in one place.
 *
 * Spec § Edge Cases and `src/lib/lapsed-portal-scope.ts` both rely on "the
 * existing rules that block sending still apply at send time". Until T166
 * only `submitBroadcast` applied them, so the minutes-long submit → approve
 * edge — and F119's 30-day approval round — let a member who was halted, or
 * whose membership lapsed, have an E-Blast approved and sent. The rules:
 *
 *   k. the halt flag — the member's broadcasts are halted pending admin
 *      review (complaint-rate auto-halt, Clarifications Q14);
 *   l. F8 membership access — a `suspended` or `terminated` member spends no
 *      E-Blast benefit (059-membership-suspension).
 *
 * `submitBroadcast`, `approveBroadcast` (approve-as-submitted) and
 * `confirmSchedule`'s promotion (`member_approved → approved`) all read them
 * through `readMemberSendStanding`, so the three cannot drift apart.
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
 * T166 follow-up — the audit row a STAFF refusal writes, under the SAME event
 * types submit's refusals use (`broadcast_member_halted_pending_review`,
 * `broadcast_membership_suspended_blocked`), so "why was this member's E-Blast
 * refused" is one query whichever surface refused it. `surface` tells the two
 * staff edges apart. Ids only; `related_member_id`, never `member_id` — a staff
 * act is not member activity and must not fire the 0009 `last_activity_at`
 * trigger (#336/#337); `actor_role` is the session role as held (`?? null`).
 */
export interface StandingRefusalAuditInput {
  readonly refusal: 'halted' | 'not_in_good_standing';
  readonly surface: 'approve_as_submitted' | 'schedule_confirm';
  readonly tenantSlug: string;
  readonly memberId: string;
  readonly broadcastId: string;
  readonly actorUserId: string;
  readonly actorRole: string | null;
  readonly requestId: string | null;
}

export function standingRefusalAuditEvent(input: StandingRefusalAuditInput): AuditEmitInput {
  const eventType: F7AuditEventType =
    input.refusal === 'halted' ? 'broadcast_member_halted_pending_review' : 'broadcast_membership_suspended_blocked';
  const verb = input.surface === 'approve_as_submitted' ? 'Approve' : 'Schedule confirm';
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
