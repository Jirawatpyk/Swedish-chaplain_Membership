import { getLocale } from 'next-intl/server';
import { PortalBenefitsSummaryCard } from '@/components/benefits/portal-benefits-summary-card';
import { env } from '@/lib/env';
import { deriveBenefitsStat } from '../_lib/dashboard-stats';
import { loadDashboardBenefitUsage } from './dashboard-reads';
import type { TenantContext } from '@/modules/tenants';

const PORTAL_BENEFITS_HREF = '/portal/benefits';
const EBLAST_COMPOSE_HREF = '/portal/broadcasts/new';

/**
 * 057 portal redesign §4.1 — 2-col benefits quota panel (right column).
 *
 * Async server component that reads the SAME per-request cached benefit
 * usage the `BenefitsStatSection` uses (React `cache()` dedups), then renders
 * the portal summary card (spec 122 US3, the `Main` board). Lives in its OWN Suspense boundary so the
 * benefits read never blocks the 3 stat cards (F2 — the page body must not
 * `await` benefit usage, which would serialise every stat boundary AND make
 * BenefitsStatSection's skeleton dead).
 *
 * Collapses (returns null) when usage is unavailable, errored, or empty.
 * `loadDashboardBenefitUsage` returns three shapes (D1 review finding C):
 * a `BenefitUsage` VO, `null` (benign no-plan `member_not_found`), or the
 * `'error'` sentinel (a real compute failure). BenefitUsageCard's
 * `BenefitUsage|null` contract is NOT changed — both `'error'` and `null` are
 * collapsed here. The stat card (BenefitsStatSection) shows the "unavailable"
 * warning (error) or neutral "No benefits yet" (null); this panel simply hides
 * to avoid a half-broken layout.
 */
export async function BenefitsPanelSection({
  ctx,
  memberId,
}: {
  readonly ctx: TenantContext;
  readonly memberId: string;
}): Promise<React.JSX.Element | null> {
  const locale = await getLocale();
  const usage = await loadDashboardBenefitUsage(ctx, memberId);
  // Collapse on error — the stat card (BenefitsStatSection) already shows the
  // "Benefits unavailable" warning variant; the panel adds nothing more.
  if (usage === 'error') return null;
  // Collapse on the benign no-plan case (null) too — narrows `usage` to a
  // real BenefitUsage VO for the card props below (the stat card shows the
  // neutral "No benefits yet" empty state for this member).
  if (usage === null) return null;

  const benefitsStat = deriveBenefitsStat(usage);
  if (benefitsStat.kind === 'empty') return null;

  // "Compose E-Blast" beside the E-Blast bar, only while F7 is on — the
  // compose route 503s behind the kill switch (same gate as the benefits page).
  const quantifiable = usage.quantifiable.map((b) =>
    b.key === 'eblast' && env.features.f7Broadcasts ? { ...b, actionHref: EBLAST_COMPOSE_HREF } : b,
  );

  return (
    <PortalBenefitsSummaryCard
      locale={locale}
      membershipYear={usage.membershipYear}
      quantifiable={quantifiable}
      fullHref={PORTAL_BENEFITS_HREF}
      headingId="dashboard-benefits-panel"
    />
  );
}
