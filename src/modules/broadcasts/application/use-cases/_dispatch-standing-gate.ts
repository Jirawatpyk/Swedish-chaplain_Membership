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
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import { readMemberSendStanding, type MemberSendStandingDeps, type StandingRefusal } from './_member-send-standing';

/** The standing reads a dispatch leg makes. */
export interface DispatchStandingDeps extends MemberSendStandingDeps {
  /**
   * R2 — the UNMEMOISED halt read, consulted only before a permanent `halted`
   * refusal. A composition that memoises `membersBridge` (the cron does, per
   * tick) MUST set it to the raw bridge; absent, `membersBridge` itself is
   * re-read, which is only fresh when it is not memoised.
   */
  readonly haltReadFresh?: Pick<MembersBridgePort, 'getMembersHaltedInTenant'>;
}

export type DispatchStandingDecision =
  | { readonly kind: 'send' }
  | { readonly kind: 'hold' }
  | {
      readonly kind: 'refuse';
      /** Which refusal audit row (`standingRefusalAuditEvent`) to write — the standing itself, so the row names its `access`. */
      readonly refusal: StandingRefusal;
      /** The member-facing / `failure_reason` token. */
      readonly reason: 'member_halted' | 'member_not_in_good_standing';
    }
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
    case 'halted':
      return { kind: 'refuse', refusal: standing, reason: 'member_halted' };
    case 'not_in_good_standing':
      return standing.access === 'suspended'
        ? { kind: 'hold' }
        : { kind: 'refuse', refusal: standing, reason: 'member_not_in_good_standing' };
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
 * The hold's only trace. Deliberately NOT an audit row: a held E-Blast is
 * re-checked every 5 minutes, so a row per tick would bury the log. Ids only —
 * no member id, no address, no F8 reason.
 */
export function recordDispatchHold(tenantSlug: string, broadcastId: string, leg: 'live' | 'import'): void {
  logger.info({ tenantId: tenantSlug, broadcastId, leg }, 'broadcasts.dispatch.standing_held');
  broadcastsMetrics.dispatchStandingHeldTotal(tenantSlug);
}
