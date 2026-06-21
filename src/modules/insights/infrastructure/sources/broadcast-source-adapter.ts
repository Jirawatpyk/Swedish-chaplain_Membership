/**
 * F9 broadcast source adapter (US1 + US4 / T017) — composes the broadcasts
 * PUBLIC BARREL, no deep imports (Constitution Principle III).
 *
 *  - `countAwaitingApproval` (US1 / AS-2) → dashboard "needs attention" count.
 *  - `getEblastConsumption` (US4 / AS-1) → E-Blasts a member has sent this
 *    membership year + the last-sent date.
 *
 * `used` (authoritative, tenant-tz quota-year-scoped) comes from
 * `computeQuotaCounter`. A quota *failure* is NOT masked as `used = 0`
 * (review-run C-1): the member is already resolved by `computeBenefitUsage`,
 * so a quota error here is a real source fault (e.g. a DB outage laundered
 * through the F7 plan bridge into `member_not_found`, or an invariant
 * violation) — we throw so the use-case logs `errKind` + returns
 * `compute_failed` (a masked zero would fire a *false* under-use warning).
 * This mirrors `member-plan-source-adapter`'s fail-loud contract.
 *
 * `lastUsedAt` is best-effort: `listMemberBroadcasts` page 1 is ordered by
 * `createdAt` desc (NOT `sentAt`), so we scan that 20-row window for the max
 * usage timestamp among the two quota-consuming terminal states — a full `sent`
 * (`sentAt`) OR a partial-accepted send (`partial_delivery_accepted`, whose only
 * usage timestamp is `partialDeliveryAcceptedAt`; FR-008c). Coalescing the two
 * means a partial-accept-only member (used>0, no `sentAt`) is not shown "used,
 * but never used". Exact for the common case; a member with >20 broadcasts whose
 * current-year usage sits outside the window may show a stale or null last-used
 * date even when `used > 0` (review-run I-1). The count is unaffected.
 */
import {
  makeBroadcastApprovalCounter,
  computeQuotaCounter,
  makeComputeQuotaDeps,
  listMemberBroadcasts,
  makeListMemberBroadcastsDeps,
} from '@/modules/broadcasts';
import { asMemberId } from '@/modules/members';
import { env } from '@/lib/env';
import type { TenantContext } from '@/modules/tenants';
import { tenantYearBoundsUtcMs } from '../../application/tenant-year';
import type {
  BenefitConsumption,
  BroadcastConsumptionSource,
} from '../../application/ports/source-ports';

/** Page-1 window scanned for the most-recent sent broadcast (last-used date). */
const LAST_SENT_SCAN_PER_PAGE = 20;

export const broadcastSourceAdapter: BroadcastConsumptionSource = {
  async countAwaitingApproval(ctx: TenantContext): Promise<number> {
    return makeBroadcastApprovalCounter(ctx.slug).countAwaitingApproval(ctx);
  },

  async getEblastConsumption(
    ctx: TenantContext,
    memberId: string,
    membershipYear: number,
  ): Promise<BenefitConsumption> {
    const mid = asMemberId(memberId);
    const quota = await computeQuotaCounter(makeComputeQuotaDeps(ctx.slug), {
      memberId: mid,
    });
    if (!quota.ok) {
      // An over-subscription (used + reserved > cap — e.g. a plan downgrade or
      // extra pending broadcasts left more reserved than the new cap) is a REAL,
      // DISPLAYABLE state, not a source fault: the cause carries the true `used`
      // (this year's sent count), so render it (used / cap) rather than breaking
      // the whole benefit view. NOTE: F7's `computeQuotaCounter` is intentionally
      // strict here (it also backs the submit precheck); the leniency belongs on
      // this F9 read path. Every OTHER quota error is a genuine fault → still
      // fail loud (a masked `used: 0` would fire a false under-use warning; here
      // we use the cause's real `used`, never a fake zero).
      if (
        quota.error.kind === 'quota.invariant_violation' &&
        quota.error.cause.code === 'quota_counter.over_subscription'
      ) {
        return { used: quota.error.cause.used, lastUsedAt: null };
      }
      throw new Error(`eblast consumption lookup failed: ${quota.error.kind}`);
    }
    // `used` is the count for computeQuotaCounter's internally-derived quota
    // year. That equals `membershipYear` because both this module and F7 use
    // the same shared `systemClock` (insights-deps wires clock: systemClock),
    // so the only divergence is a sub-millisecond read gap at the tenant-tz
    // New-Year boundary — accepted (self-corrects on refresh). F9 only views
    // the current year (the quota counter cannot scope to a past year).
    const used = quota.value.counter.used;

    let lastUsedAt: string | null = null;
    if (used > 0) {
      // Year-bound the last-sent scan so a PRIOR-year send can never surface as
      // "last used" against a current-year count (R#7). Page 1 is ordered by
      // createdAt desc, so a member with >20 broadcasts whose current-year send
      // is outside the window yields null ("not used yet") — a lesser, honest
      // degradation, never a wrong-year date.
      const { startMs, endMs } = tenantYearBoundsUtcMs(membershipYear, env.tenant.timezone);
      const list = await listMemberBroadcasts(
        makeListMemberBroadcastsDeps(ctx.slug),
        { memberId: mid, page: 1, perPage: LAST_SENT_SCAN_PER_PAGE },
      );
      let newest: Date | null = null;
      for (const b of list.rows) {
        // FR-008c — both terminal states that consume the quota slot count as
        // "used": a full `sent` (timestamped by `sentAt`) and a partial-accepted
        // send (`partial_delivery_accepted`, timestamped by
        // `partialDeliveryAcceptedAt` — it has NO `sentAt`). Coalesce the usage
        // timestamp so a partial-accept-only member is not shown "used, but never
        // used" (used>0 yet null lastUsedAt). Skip only when BOTH are null.
        const usedAt = b.sentAt ?? b.partialDeliveryAcceptedAt;
        if (usedAt === null) continue;
        const ms = usedAt.getTime();
        if (ms < startMs || ms >= endMs) continue; // current membership year only
        if (newest === null || usedAt > newest) newest = usedAt;
      }
      lastUsedAt = newest === null ? null : newest.toISOString();
    }
    return { used, lastUsedAt };
  },
};
