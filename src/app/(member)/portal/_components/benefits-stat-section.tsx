import { getTranslations } from 'next-intl/server';
import { StatCard } from '@/components/portal/dashboard/stat-card';
import { deriveBenefitsStat } from '../_lib/dashboard-stats';
import { loadDashboardBenefitUsage } from './dashboard-reads';
import type { TenantContext } from '@/modules/tenants';

/**
 * 057 portal redesign §4.1 — Benefits stat card section.
 *
 * Resolves the cached benefit usage VO, derives the display label/variant,
 * and renders a `StatCard`. A transient read error returns the `'error'`
 * sentinel and renders a warning "Benefits unavailable" — distinct from the
 * genuine empty state so the member is not misled (Defer 1 D1 code review).
 */
export async function BenefitsStatSection({
  ctx,
  memberId,
}: {
  readonly ctx: TenantContext;
  readonly memberId: string;
}): Promise<React.JSX.Element> {
  const t = await getTranslations('portal.dashboard.benefits');
  const usage = await loadDashboardBenefitUsage(ctx, memberId);

  const stat = deriveBenefitsStat(usage);

  const value =
    stat.kind === 'error'
      ? t('errorValue')
      : stat.kind === 'empty'
        ? t('emptyValue')
        : stat.kind === 'under-use'
          ? t('underUseValue', { count: stat.underUseCount })
          : t('onTrackValue');

  const sub =
    stat.kind === 'error'
      ? t('errorSub')
      : stat.kind === 'empty'
        ? t('emptySub')
        : stat.kind === 'under-use'
          ? t('underUseSub')
          : t('onTrackSub');

  // Conditionally spread to satisfy exactOptionalPropertyTypes.
  const variantProps =
    stat.variant !== 'neutral' ? { variantLabel: value } : {};

  return (
    <StatCard
      label={t('label')}
      value={value}
      sub={sub}
      variant={stat.variant}
      {...variantProps}
    />
  );
}
