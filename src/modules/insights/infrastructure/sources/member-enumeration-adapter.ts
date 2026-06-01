/**
 * F9 member-enumeration source adapter (go-live P1-4 / FR-004) — composes the
 * members PUBLIC BARREL (`directorySearchWithCount` + the `buildMembersDeps`
 * composition root), no deep/foreign-table import (Constitution Principle III).
 *
 * Enumerates the tenant's ACTIVE members with their plan ref for the
 * cross-member quota-insight roll-up. ACTIVE-only: inactive / archived members
 * no longer consume current-year quota, so they must not dilute the under-use
 * counts (FR-004 / AC8). Distinct from `memberPlanSourceAdapter` (single-member
 * lookup) — this is the whole-tenant pass.
 *
 * Pagination mirrors `member-source-adapter.joinDistribution`: pageSize MUST be
 * 100 because `directorySearchWithCount` clamps `limit` to 100 — a larger value
 * makes `items.length < pageSize` always true and the loop would stop after the
 * first page (undercounting tenants with >100 members). Off the hot path
 * (~5-min snapshot cron).
 *
 * Fail-loud: a directory-search error throws so the snapshot use-case logs
 * `errKind` + returns `compute_failed` rather than a partial/zero member set
 * (which would understate under-use).
 *
 * KNOWN LIMITATION (accepted): offset pagination is NOT a consistent snapshot —
 * each page is its own `runInTenant` tx / MVCC snapshot, and the directory's
 * default sort (`last_activity_at DESC NULLS LAST, member_id`) is over a column
 * the F3 activity trigger mutates, so a member could be skipped or double-counted
 * at a page boundary if it churns mid-enumeration. Identical to the existing
 * `member-source-adapter.joinDistribution` pattern; off the hot path (~5-min cron,
 * self-corrects next run) and inert below 100 members (SweCham ≈131 → ≤2 pages).
 * Promote to a single keyset pass on a stable key if a tenant nears ~20k members.
 */
import { directorySearchWithCount } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import type { TenantContext } from '@/modules/tenants';
import type { MemberEnumerationSource } from '../../application/ports/source-ports';
import type { MemberPlanRef } from '../../domain/quota-underuse';

/** Mandatory: `directorySearchWithCount` clamps `limit` to 100 (see note above). */
const PAGE_SIZE = 100;

export const memberEnumerationAdapter: MemberEnumerationSource = {
  async listActiveWithPlan(
    ctx: TenantContext,
  ): Promise<readonly MemberPlanRef[]> {
    const deps = buildMembersDeps(ctx);
    const out: MemberPlanRef[] = [];
    let offset = 0;
    for (;;) {
      const result = await directorySearchWithCount(
        { tenant: deps.tenant, memberRepo: deps.memberRepo },
        { status: ['active'], limit: PAGE_SIZE, offset },
      );
      if (!result.ok) {
        throw new Error(
          `MemberEnumerationSource: directory search failed (${result.error.type})`,
        );
      }
      for (const row of result.value.items) {
        out.push({
          memberId: row.member.memberId,
          planId: row.member.planId,
          planYear: row.member.planYear,
        });
      }
      offset += result.value.items.length;
      if (
        result.value.items.length < PAGE_SIZE ||
        offset >= result.value.total
      ) {
        break;
      }
    }
    return out;
  },
};
