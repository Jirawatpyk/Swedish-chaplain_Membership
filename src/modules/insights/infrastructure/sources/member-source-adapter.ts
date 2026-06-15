/**
 * F9 `MemberSource` adapter (US1 / T017).
 *
 * Reads membership counts via the members PUBLIC BARREL only
 * (`directorySearchWithCount` + the module composition root `buildMembersDeps`)
 * — no deep/foreign-table imports (Constitution Principle III). The admin
 * members page uses the same two entry points.
 *
 * Counts compose from the existing `directorySearchWithCount` (its `total` is
 * the full filtered count regardless of `limit`): one COUNT query per status /
 * per risk band. This runs in the ~5-min snapshot cron, so the handful of
 * COUNT queries is acceptable for the SC-002 scale; a dedicated aggregate
 * use-case can be promoted on the members barrel later if a tenant approaches
 * the ~20k revisit trigger (spec Assumptions).
 */
import { directorySearchWithCount } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import type { TenantContext } from '@/modules/tenants';
import type {
  AtRiskMemberRef,
  MemberJoinDistribution,
  MemberSource,
  MemberStatusCounts,
} from '../../application/ports/source-ports';
import { monthKeyOf } from '../../domain/trend-window';

/** Risk bands that count as "at-risk needing follow-up" (FR-002/004). */
const AT_RISK_BANDS = ['critical', 'at-risk', 'warning'] as const;

async function countWith(
  ctx: TenantContext,
  filter: Parameters<typeof directorySearchWithCount>[1],
): Promise<number> {
  const deps = buildMembersDeps(ctx);
  const result = await directorySearchWithCount(
    { tenant: deps.tenant, memberRepo: deps.memberRepo },
    { ...filter, limit: 1, offset: 0 },
  );
  if (!result.ok) {
    throw new Error(`MemberSource: directory count failed (${result.error.type})`);
  }
  return result.value.total;
}

export const memberSourceAdapter: MemberSource = {
  async countByStatus(ctx: TenantContext): Promise<MemberStatusCounts> {
    const [active, inactive, archived] = await Promise.all([
      countWith(ctx, { status: ['active'] }),
      countWith(ctx, { status: ['inactive'] }),
      countWith(ctx, { status: ['archived'] }),
    ]);
    return { active, inactive, archived };
  },

  async countAtRisk(ctx: TenantContext): Promise<number> {
    const counts = await Promise.all(
      AT_RISK_BANDS.map((band) => countWith(ctx, { riskBand: band })),
    );
    return counts.reduce((sum, n) => sum + n, 0);
  },

  async listAtRisk(ctx: TenantContext, limit: number): Promise<readonly AtRiskMemberRef[]> {
    const deps = buildMembersDeps(ctx);
    const out: AtRiskMemberRef[] = [];
    // Most-urgent bands first; stop once `limit` is reached.
    for (const band of AT_RISK_BANDS) {
      if (out.length >= limit) break;
      const result = await directorySearchWithCount(
        { tenant: deps.tenant, memberRepo: deps.memberRepo },
        { riskBand: band, limit: Math.max(1, limit - out.length), offset: 0 },
      );
      if (!result.ok) {
        throw new Error(`MemberSource: at-risk list failed (${result.error.type})`);
      }
      for (const row of result.value.items) {
        out.push({
          memberId: row.member.memberId,
          companyName: row.member.companyName,
          // Rows matched the `riskBand: band` filter, so the band is `band`
          // (an at-risk band, never 'healthy') — matches AtRiskMemberRef.
          riskScoreBand: band,
        });
      }
    }
    return out.slice(0, limit);
  },

  async joinDistribution(
    ctx: TenantContext,
    monthKeys: readonly string[],
    timeZone: string,
  ): Promise<MemberJoinDistribution> {
    const firstKey = monthKeys[0] ?? '';
    const windowSet = new Set(monthKeys);
    const byMonth: Record<string, number> = {};
    let baseline = 0;
    const deps = buildMembersDeps(ctx);
    // `directorySearchWithCount` clamps `limit` to 100, so pageSize MUST be 100
    // — a larger value makes `items.length < pageSize` always true and the loop
    // would break after the first page (undercounting tenants with >100 members).
    const pageSize = 100;
    let offset = 0;
    // Paginate ALL members (every status) so the cumulative series counts
    // every member ever joined. Off the hot path (~5-min cron); promote a
    // GROUP-BY-month aggregate if a tenant nears the ~20k revisit trigger.
    for (;;) {
      const result = await directorySearchWithCount(
        { tenant: deps.tenant, memberRepo: deps.memberRepo },
        { status: ['active', 'inactive', 'archived'], limit: pageSize, offset },
      );
      if (!result.ok) {
        throw new Error(`MemberSource: join distribution failed (${result.error.type})`);
      }
      for (const row of result.value.items) {
        // FR-001a member-growth keys off the true JOIN date (`registrationDate`),
        // NOT `createdAt` (the row-insertion instant). For a bulk-imported tenant
        // every `createdAt` clusters in the import month while `registrationDate`
        // spans years — keying off createdAt collapses the whole chart into one
        // import-month spike (F9 #1). registrationDate is the join anchor used by
        // the startup-duration policy + the GDPR export too.
        const key = monthKeyOf(row.member.registrationDate, timeZone);
        // `YYYY-MM` sorts lexicographically == chronologically, so `< firstKey`
        // correctly means "joined before the window" → baseline.
        if (key < firstKey) baseline += 1;
        else if (windowSet.has(key)) byMonth[key] = (byMonth[key] ?? 0) + 1;
      }
      offset += result.value.items.length;
      if (result.value.items.length < pageSize || offset >= result.value.total) break;
    }
    return { baseline, byMonth };
  },
};
