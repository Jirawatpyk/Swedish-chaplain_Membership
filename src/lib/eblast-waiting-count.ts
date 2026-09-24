/**
 * F119 T132 (FR-023; contracts/dashboard-and-notifications.md § 1.3, research
 * R18) — the E-Blast waiting count behind the staff nav's Broadcasts badge:
 * how many E-Blasts are waiting on MARKETING (`MARKETING_TURN_STATUSES`, the
 * set the `broadcasts_marketing_turn_count` gauge counts), as a live indexed
 * `count(*)` at render — correct immediately, not a cron snapshot (the F114
 * `readPendingChangeRequests` precedent this mirrors).
 *
 * The answer is discriminated, never `null` (the F114 R-H2 lesson — "hidden by
 * design" and "the read faulted" are different facts):
 *
 *   - `hidden` — `feature_off`: E-Blasts are switched off (the Broadcasts item
 *                is dropped from the nav anyway); `not_permitted`: the viewer
 *                lacks `broadcasts.read` (asked of the evaluator — every role
 *                that holds it sees the count, `manager` included). Both
 *                answered WITHOUT a query. `flag_off`: the approval round is
 *                dark (`FEATURE_EBLAST_MEMBER_APPROVAL` off) AND no row is in
 *                an approval-round stage — today's queue, unchanged. With the
 *                flag off but a row still in the round, the count SHOWS: an
 *                in-flight E-Blast is never invisible to the people who must
 *                act on it (R18's "flag ON or rows exist").
 *   - `ok`     — the count; the nav renders it when > 0.
 *   - `unavailable` — a throw; no badge, one log line under the caller's
 *                errorId (the staff page never fails for a badge).
 *
 * `src/lib/**` is the composition layer: the flag, the evaluator and the
 * counter adapter meet here; Presentation calls this, never the repo.
 */
import { env } from '@/lib/env';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { canPerform } from '@/lib/rbac';
import type { Role } from '@/modules/auth/domain/role';
import {
  isEblastMemberApprovalEnabled,
  makeBroadcastApprovalCounter,
  makeBroadcastQueueReads,
  type BroadcastStatus,
} from '@/modules/broadcasts';
import type { TenantContext } from '@/modules/tenants';

export type EblastWaitingHiddenReason = 'feature_off' | 'not_permitted' | 'flag_off';

export type EblastWaitingRead =
  | { readonly kind: 'ok'; readonly count: number }
  | { readonly kind: 'hidden'; readonly reason: EblastWaitingHiddenReason }
  | { readonly kind: 'unavailable' };

const UNAVAILABLE: EblastWaitingRead = { kind: 'unavailable' };

export async function readEblastWaitingCount(
  tenant: TenantContext,
  role: Role | (string & {}),
  errorId: string,
): Promise<EblastWaitingRead> {
  if (!env.features.f7Broadcasts) return { kind: 'hidden', reason: 'feature_off' };
  if (!canPerform(role, 'broadcasts.read')) return { kind: 'hidden', reason: 'not_permitted' };
  try {
    const counts = await makeBroadcastApprovalCounter(tenant.slug).countMarketingQueue(tenant);
    if (!isEblastMemberApprovalEnabled() && counts.inApprovalRound === 0) return { kind: 'hidden', reason: 'flag_off' };
    return { kind: 'ok', count: counts.marketingTurn };
  } catch (e) {
    logger.error({ errorId, tenantId: tenant.slug, err: errKind(e) }, 'broadcasts.waiting-count: read failed');
    return UNAVAILABLE;
  }
}

/**
 * The nav read's deadline — 1,500 ms, the F114 badge's budget and for the
 * same reason (`NAV_BADGE_READ_TIMEOUT_MS`): the staff LAYOUT awaits this
 * before it can build the nav, on every `/admin/**` page, and the pooled
 * connection's own bounds add up to ~8 s.
 */
export const EBLAST_NAV_BADGE_TIMEOUT_MS = 1_500;

const TIMED_OUT = Symbol('eblast-nav-badge-timed-out');

/** The bounded nav read: the count inside the deadline, else `unavailable` + one log line. */
export async function readEblastWaitingCountForNav(
  tenant: TenantContext,
  role: Role | (string & {}),
): Promise<EblastWaitingRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), EBLAST_NAV_BADGE_TIMEOUT_MS);
  });
  try {
    const winner = await Promise.race([readEblastWaitingCount(tenant, role, 'M119.nav.eblast_badge_failed'), deadline]);
    if (winner !== TIMED_OUT) return winner;
    logger.error(
      { errorId: 'M119.nav.eblast_badge_timed_out', tenantId: tenant.slug, timeoutMs: EBLAST_NAV_BADGE_TIMEOUT_MS },
      'broadcasts.waiting-count: nav badge read exceeded its deadline',
    );
    return UNAVAILABLE;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * F119 T116 (FR-025; contracts/dashboard-and-notifications.md § 1.1, research
 * R18) — the queue's per-stage chip counts, with the approval-round flag the
 * chip strip needs to apply the SAME "flag ON or rows exist" rule as the nav
 * badge above: a new-stage chip is offered while the flag is on, or while the
 * tenant has a row in that stage. The rule is applied per chip by
 * `queue-filters.tsx`, which is handed both inputs; this is the one place they
 * are read.
 *
 * Discriminated like the nav read: `unavailable` is a failed read (logged
 * under the caller's errorId), never "zero rows" — the page renders the chips
 * without numbers and offers every stage, because hiding a stage an in-flight
 * E-Blast sits in is the worse failure.
 */
export type EblastStageChips =
  | {
      readonly kind: 'ok';
      readonly counts: Readonly<Record<BroadcastStatus, number>>;
      readonly approvalRoundEnabled: boolean;
    }
  | { readonly kind: 'unavailable'; readonly approvalRoundEnabled: boolean };

export async function readEblastStageChips(tenant: TenantContext, errorId: string): Promise<EblastStageChips> {
  const approvalRoundEnabled = isEblastMemberApprovalEnabled();
  try {
    const counts = await makeBroadcastQueueReads(tenant.slug).countByStatus(tenant);
    return { kind: 'ok', counts, approvalRoundEnabled };
  } catch (e) {
    logger.error({ errorId, tenantId: tenant.slug, err: errKind(e) }, 'broadcasts.stage-counts: read failed');
    return { kind: 'unavailable', approvalRoundEnabled };
  }
}
