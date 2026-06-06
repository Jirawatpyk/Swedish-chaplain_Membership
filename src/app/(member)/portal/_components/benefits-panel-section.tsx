import { getLocale } from 'next-intl/server';
import { BenefitUsageCard } from '@/components/benefits/benefit-usage-card';
import { deriveBenefitsStat } from '../_lib/dashboard-stats';
import { loadDashboardBenefitUsage } from './dashboard-reads';
import type { TenantContext } from '@/modules/tenants';

const PORTAL_BENEFITS_HREF = '/portal/benefits';

/**
 * 057 portal redesign §4.1 — 2-col benefits quota panel (right column).
 *
 * Async server component that reads the SAME per-request cached benefit
 * usage the `BenefitsStatSection` uses (React `cache()` dedups), then renders
 * the compact `BenefitUsageCard`. Lives in its OWN Suspense boundary so the
 * benefits read never blocks the 3 stat cards (F2 — the page body must not
 * `await` benefit usage, which would serialise every stat boundary AND make
 * BenefitsStatSection's skeleton dead).
 *
 * Renders nothing when usage is unavailable or empty (no benefits to show) —
 * the panel simply collapses, same as the prior page-body conditional.
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
  if (usage === null) return null;

  const benefitsStat = deriveBenefitsStat(usage);
  if (benefitsStat.kind === 'empty') return null;

  return (
    <BenefitUsageCard
      locale={locale}
      membershipYear={usage.membershipYear}
      elapsedYearPct={usage.elapsedYearPct}
      quantifiable={usage.quantifiable}
      active={usage.active}
      aggregateConsumedPct={usage.aggregateConsumedPct}
      underUseWarning={usage.underUseWarning}
      compact
      previewHref={PORTAL_BENEFITS_HREF}
      headingId="dashboard-benefits-panel"
    />
  );
}
