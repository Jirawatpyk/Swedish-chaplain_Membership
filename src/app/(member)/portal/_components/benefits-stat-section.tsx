import { getTranslations } from 'next-intl/server';
import { StatCard } from '@/components/portal/dashboard/stat-card';
import { deriveBenefitsStat } from '../_lib/dashboard-stats';
import { loadDashboardBenefitUsage } from './dashboard-reads';
import type { TenantContext } from '@/modules/tenants';

/**
 * 057 portal redesign §4.1 — Benefits stat card section.
 *
 * Resolves the cached benefit usage VO, derives the display label/variant,
 * and renders a `StatCard`. A null usage (compute miss, spec risk PM-3)
 * shows a neutral placeholder — never an error state that blocks the full
 * dashboard render.
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

  // Risk PM-3: compute miss (null) shows a neutral placeholder.
  if (usage === null) {
    return (
      <StatCard
        label={t('label')}
        value={t('emptyValue')}
        sub={t('emptySub')}
        variant="neutral"
      />
    );
  }

  const stat = deriveBenefitsStat(usage);

  const value =
    stat.kind === 'empty'
      ? t('emptyValue')
      : stat.kind === 'under-use'
        ? t('underUseValue', { count: stat.underUseCount })
        : t('onTrackValue');

  const sub =
    stat.kind === 'empty'
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
