import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/portal/dashboard/stat-card';
import { deriveMembershipStat } from '../_lib/dashboard-stats';
import { loadDashboardRenewalCycle } from './dashboard-reads';

/**
 * 057 portal redesign §4.1 — Membership stat card section.
 *
 * Async server component — resolves the cached renewal cycle, derives
 * the display label/variant, and renders a `StatCard`. Wrap in Suspense
 * with `<StatSkeleton>` to stream this section independently.
 *
 * `StatCard` props used: `label` (already-localised), `value`, `sub`,
 * `variant`, `variantLabel` (required for non-neutral variants per spec
 * a11y-3 — colour alone is never the sole signal).
 */
export async function MembershipStatSection({
  tenantId,
  memberId,
}: {
  readonly tenantId: string;
  readonly memberId: string;
}): Promise<React.JSX.Element> {
  const t = await getTranslations('portal.dashboard.membership');
  const cycle = await loadDashboardRenewalCycle(tenantId, memberId);
  const stat = deriveMembershipStat(cycle, new Date());

  const value =
    stat.kind === 'empty'
      ? t('emptyValue')
      : stat.kind === 'overdue'
        ? t('overdueValue')
        : stat.kind === 'due'
          ? t('renewDueValue')
          : t('activeValue');

  const sub =
    stat.kind === 'empty'
      ? t('emptySub')
      : stat.kind === 'overdue' && stat.daysRemaining !== null
        ? t('overdueSub', { days: Math.abs(stat.daysRemaining) })
        : stat.daysRemaining !== null && stat.kind === 'due'
          ? t('daysRemainingSub', { days: stat.daysRemaining })
          : t('activeSub');

  // variantLabel mirrors the value text so the icon + text pair conveys
  // the same information (WCAG 1.4.1 — not colour alone).
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

/** Shimmer skeleton while the async section streams in. */
export function StatSkeleton(): React.JSX.Element {
  return (
    <Card aria-busy="true" aria-hidden="true" className="h-full">
      <CardContent className="flex flex-col gap-2 py-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-3 w-40" />
      </CardContent>
    </Card>
  );
}
