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
