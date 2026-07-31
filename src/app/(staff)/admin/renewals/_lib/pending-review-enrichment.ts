/**
 * Batch member-name enrichment for the `/admin/renewals?view=pending-review`
 * discovery list (070 F8 item #18).
 *
 * The pending-review section only renders each cycle's member **company
 * name**. The use-case doc-header for `loadPendingReactivationReview`
 * states the intended pattern explicitly: "the Presentation layer
 * batch-enriches company names via F3's `findManyByIdsInTx`". This helper
 * is that batch read — ONE `runInTenant` (RLS-scoped) issuing a single
 * `SELECT … WHERE member_id = ANY($1)` round-trip for ALL pending cycles,
 * replacing the prior per-row `fetchMemberDisplay` N+1 (which ran two
 * sequential `runInTenant` queries — member + primary-contact — per cycle
 * and then DISCARDED the primary-contact result the list never renders).
 *
 * Tenant isolation: the single `runInTenant(ctx, …)` wrapper applies the
 * Postgres RLS+FORCE policies via `SET LOCAL app.current_tenant`
 * (Constitution Principle I two-layer isolation), and `findManyByIdsInTx`
 * additionally filters `tenant_id` explicitly in its WHERE clause (added at
 * the 107-auto-invoice Task 15 review — the app-layer half of the two
 * layers). It never reaches for the pool-global `db` singleton.
 *
 * Error semantics: an infrastructure failure (RLS reject / connection /
 * timeout) from the repo PROPAGATES (throw) so the caller's best-effort
 * try/catch renders a "couldn't load" surface — never a silent blank
 * list. A member that simply isn't in the returned map (archived /
 * cross-tenant-hidden) is ABSENT from the map; the caller degrades that
 * row gracefully to the cycle short-id, consistent with the prior
 * behaviour.
 */
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import {
  asMemberId,
  f3DrizzleMemberRepo,
  type MemberNumber,
} from '@/modules/members';

/**
 * UX-audit PR-B B4 — the per-member facts the pending-review list needs to
 * render a Member cell that matches the escalation-queue + invoice-table: a
 * company-name LINK to `/admin/members/{memberId}` plus the `SCCM-NNNN`
 * member number in muted text.
 *
 * `memberNumber` is the RAW 055 member-number integer (branded). The caller
 * (`PendingReviewSection`) resolves the per-tenant prefix ONCE via the shared
 * RLS-safe `resolveMemberNumberPrefix` helper and formats it with
 * `formatMemberNumber` server-side, so the client list ships a display string
 * only — never the raw integer (mirrors `members-table.tsx`'s deliberate
 * `member_number_display` choice).
 */
export interface PendingReviewMemberInfo {
  readonly companyName: string;
  readonly memberNumber: MemberNumber;
  readonly memberId: string;
}

/**
 * Resolve a `memberId → {companyName, memberNumber, memberId}` map for the
 * supplied cycle member ids in a SINGLE batched, tenant-scoped read.
 *
 * @param tenantSlug  RLS tenant slug (validated by `asTenantContext`).
 * @param memberIds   Cycle member ids (duplicates tolerated — deduped here).
 * @returns           Map keyed by the raw member-id string; missing members
 *                    are simply absent (caller supplies the fallback).
 * @throws            On an infrastructure repo error (caller catches).
 */
export async function fetchPendingReviewCompanyNames(args: {
  readonly tenantSlug: string;
  readonly memberIds: readonly string[];
}): Promise<ReadonlyMap<string, PendingReviewMemberInfo>> {
  const distinctIds = [...new Set(args.memberIds)];
  // Empty list → no query needed (an `ANY('{}')` would be a wasted
  // round-trip and some drivers choke on the empty-array literal).
  if (distinctIds.length === 0) {
    return new Map<string, PendingReviewMemberInfo>();
  }

  const tenantContext = asTenantContext(args.tenantSlug);
  const result = await runInTenant(tenantContext, (tx) =>
    f3DrizzleMemberRepo.findManyByIdsInTx(
      tx,
      args.tenantSlug,
      distinctIds.map(asMemberId),
    ),
  );

  if (!result.ok) {
    // Infrastructure error — propagate so the caller's best-effort wrapper
    // renders the "couldn't load" alert instead of a silently blank list.
    throw new Error(
      `[fetchPendingReviewCompanyNames] member batch lookup failed: ${result.error.code}`,
      'cause' in result.error ? { cause: result.error.cause } : {},
    );
  }

  const infoByMemberId = new Map<string, PendingReviewMemberInfo>();
  for (const [memberId, member] of result.value) {
    // `MemberId` is a branded string subtype — key the map on the raw
    // string so the caller can look up by the cycle's plain `memberId`.
    // B4 — carry the member-number (raw int) + id so the caller can build the
    // SCCM display string + `/admin/members/{id}` link. Both are read from the
    // SAME single batch read above — no extra query, no global `db`.
    infoByMemberId.set(memberId, {
      companyName: member.companyName,
      memberNumber: member.memberNumber,
      memberId,
    });
  }
  return infoByMemberId;
}
