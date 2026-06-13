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
 * Reads (both RLS-safe — adapters wrap queries in `runInTenant`, never the
 * raw `db` singleton):
 *   1. `loadMemberRenewalStatus` (F8) — most-recent cycle of any status.
 *   2. `getMemberEngagement` (F3 narrow risk read) → `projectEngagementScore`
 *      (F9 projection, applied in presentation per the directory-list
 *      precedent). Only fetched when the F9 dashboard flag is on, mirroring
 *      the prior `MemberEngagementSection` gating.
 *
 * Both reads degrade gracefully: a renewal-read failure renders the
 * empty-state copy; an engagement-read failure omits the engagement line.
 * Neither can crash the parent member-detail page. Isolated in its own
 * Suspense boundary at the call site.
 */
import {
  loadMemberRenewalStatus,
  makeRenewalsDeps,
  daysUntilExpiry,
} from '@/modules/renewals';
import { getMemberEngagement } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { projectEngagementScore } from '@/modules/insights';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
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
  const renewalsDeps = makeRenewalsDeps(tenant.slug);
  const renewalRes = await loadMemberRenewalStatus(renewalsDeps, {
    tenantId: tenant.slug,
    memberId,
  });
  if (!renewalRes.ok) {
    logger.warn(
      { event: 'member_renewal_health_read_err', memberId },
      '[Pass A] renewal-health read failed — rendering empty state',
    );
  }
  const cycle = renewalRes.ok ? renewalRes.value.cycle : null;

  // Engagement is F9-gated (mirrors the prior standalone section). When the
  // flag is off we never fetch it and the card omits the engagement line.
  let engagementScore: number | null = null;
  let engagementBand: ReturnType<
    typeof projectEngagementScore
  >['band'] = null;
  if (env.features.f9Dashboard) {
    const membersDeps = buildMembersDeps(tenant);
    const engRes = await getMemberEngagement(memberId as MemberId, {
      tenant: membersDeps.tenant,
      memberRepo: membersDeps.memberRepo,
    });
    if (engRes.ok) {
      const projected = projectEngagementScore({
        riskScore: engRes.value.riskScore,
        riskScoreBand: engRes.value.riskScoreBand,
      });
      engagementScore = projected.score;
      engagementBand = projected.band;
    }
  }

  // Compute days-remaining from the cycle's expiry (single "now" per render).
  const daysRemaining =
    cycle !== null ? daysUntilExpiry(cycle, new Date()) : null;

  return (
    <RenewalHealthCard
      headingId="member-renewal-health-heading"
      status={cycle?.status ?? null}
      expiryIso={cycle?.expiresAt ?? null}
      daysRemaining={
        daysRemaining !== null && Number.isFinite(daysRemaining)
          ? daysRemaining
          : null
      }
      engagementScore={engagementScore}
      engagementBand={engagementBand}
      // Deep-link to the renewals dashboard. A specific-cycle deep link is a
      // Pass B refinement once the cycle-detail route is surfaced here.
      viewHref="/admin/renewals"
      // F8-completion Slice 3 — admin lapsed-comeback action. The renewal
      // invoice covers the current calendar year (the comeback cycle
      // anchors at `now`); derived server-side here, never the client clock.
      canRenew={canRenew}
      memberId={memberId}
      renewPlanYear={new Date().getUTCFullYear()}
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
