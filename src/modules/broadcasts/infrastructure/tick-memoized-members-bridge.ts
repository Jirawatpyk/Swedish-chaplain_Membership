/**
 * R6 staff-review W-P3 fix — per-tick memoization wrapper for
 * `MembersBridgePort`.
 *
 * The cron `dispatch-scheduled` loop processes up to `MAX_PER_TICK`
 * (=50) broadcasts in a single 5-min cron tick. Without this wrapper,
 * each broadcast triggers an independent `getMembersBySegment` round-
 * trip against F3 — at the SweCham SaaS expansion limit (50 ticks ×
 * one Neon RTT each ≈ 1.25s of pure DB latency on the cron critical
 * path) the loop approaches the Vercel function timeout.
 *
 * The wrapper interposes a Map cache keyed by
 * `(segmentType, JSON.stringify(params))` so multiple `all_members` or
 * `tier:premium` broadcasts in the same tick share a single resolved
 * recipient list. Tier-specific segments retain independent cache
 * entries. Cache lifetime is the wrapper instance — a fresh wrapper
 * per cron tick keeps the cache scoped tightly.
 *
 * Pure pass-through for the other 6 methods so we don't accidentally
 * cache mutating calls (`setMemberHalt`, `markBroadcastsAcknowledged`)
 * or per-member lookups whose freshness matters during a tick.
 */
import type {
  MembersBridgePort,
  MemberRecipient,
  SegmentResolveParams,
} from '../application/ports/members-bridge-port';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastSegmentType } from '../domain/value-objects/segment-type';

export function makeTickMemoizedMembersBridge(
  inner: MembersBridgePort,
): MembersBridgePort {
  const segmentCache = new Map<string, ReadonlyArray<MemberRecipient>>();

  return {
    ...inner,
    async getMembersBySegment(
      tenantCtx: TenantContext,
      segmentType: BroadcastSegmentType,
      params: SegmentResolveParams,
    ): Promise<ReadonlyArray<MemberRecipient>> {
      // Stable key: tenant slug + segment type + sorted params. Sorted
      // params guards against `{tierCodes:["A","B"]}` and
      // `{tierCodes:["B","A"]}` producing different cache slots.
      const sortedParams =
        params.tierCodes !== undefined
          ? { tierCodes: [...params.tierCodes].sort() }
          : params;
      const key = `${tenantCtx.slug}::${segmentType}::${JSON.stringify(sortedParams)}`;
      const hit = segmentCache.get(key);
      if (hit !== undefined) return hit;
      const fresh = await inner.getMembersBySegment(
        tenantCtx,
        segmentType,
        params,
      );
      segmentCache.set(key, fresh);
      return fresh;
    },
  };
}
