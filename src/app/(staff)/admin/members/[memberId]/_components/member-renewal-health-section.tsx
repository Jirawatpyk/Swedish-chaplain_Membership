/**
 * Pass A · Section 1 — Renewal & Health section (async server component).
 *
 * Surfaces the member's current renewal posture (F8) + engagement score
 * (F9) on the admin member-detail page so an admin doing a renewal call
 * never has to leave for `/admin/renewals`. Replaces the thin standalone
 * `MemberEngagementSection` — the engagement score is now MERGED into this
 * richer card (review S2: a one-value engagement card over-used real
 * estate).
 *
 * The reads live in `../_lib/member-renewal-health.ts` (shared with the
 * figures strip through `cache()`, 122 US5b-1). They are, both RLS-safe —
 * adapters wrap queries in `runInTenant`, never the raw `db` singleton:
 *   1. `loadMemberRenewalStatus` (F8) — most-recent cycle of any status.
 *   2. `getMemberEngagement` (F3 narrow risk read) → `projectEngagementScore`
 *      (F9 projection, applied in presentation per the directory-list
 *      precedent). Only fetched when the F9 dashboard flag is on, mirroring
 *      the prior `MemberEngagementSection` gating.
 *
 * Both reads degrade gracefully: a renewal-read failure renders a DISTINCT
 * "unavailable" state (via the card's `readFailed` prop) — NOT the empty
 * state, which would claim the member has no cycle when in fact the read
 * errored (Cluster 7 / G18, mirrors the portal precedent). An
 * engagement-read failure omits the engagement line. Neither can crash the
 * parent member-detail page. Isolated in its own Suspense boundary at the
 * call site.
 */
import type { TenantContext } from '@/modules/tenants';
import { loadMemberRenewalHealth } from '../_lib/member-renewal-health';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { RenewalHealthCard } from '@/components/members/renewal-health-card';

export async function MemberRenewalHealthSection({
  tenant,
  memberId,
  canRenew = false,
}: {
  readonly tenant: TenantContext;
  readonly memberId: string;
  /**
   * F8-completion Slice 3 — when true (admin role), surfaces the
   * "Renew / reactivate this member" action on the card for a lapsed
   * member. Managers pass `false`, so the affordance never renders for
   * them (no broken button). The route enforces admin-only regardless.
   */
  readonly canRenew?: boolean;
}): Promise<React.JSX.Element> {
  const health = await loadMemberRenewalHealth(tenant, memberId);

  return (
    <RenewalHealthCard
      headingId="member-renewal-health-heading"
      // Cluster 7 (G18) — a failed renewal read renders the card's distinct
      // "unavailable" state (and suppresses the lapsed-comeback action),
      // NOT the empty state.
      readFailed={health.readFailed}
      status={health.status}
      expiryIso={health.expiryIso}
      daysRemaining={health.daysRemaining}
      engagementScore={health.engagementScore}
      engagementBand={health.engagementBand}
      // Deep-link to the renewals dashboard. A specific-cycle deep link is a
      // Pass B refinement once the cycle-detail route is surfaced here.
      viewHref="/admin/renewals"
      // F8-completion Slice 3 — admin lapsed-comeback action. The renewal
      // §86/4's plan_year is derived server-side INSIDE the use-case from
      // the comeback cycle's `period_from` (L2, 068 security review) — the
      // dialog body is confirmation-only, so no plan_year is plumbed here.
      canRenew={canRenew}
      memberId={memberId}
    />
  );
}

/**
 * Suspense fallback matching the card shape (title + view link + a 3-cell
 * dl) for CLS-stable layout. Uses the canonical <Skeleton> (shimmer +
 * reduced-motion) per ux-standards § 2.1.
 */
export function MemberRenewalHealthSkeleton(): React.JSX.Element {
  return (
    <Card aria-busy="true" aria-hidden="true" className="h-full">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-28" />
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-5 w-24" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
