import { getLocale, getTranslations } from 'next-intl/server';
import { formatSatangThb } from '@/lib/format-thb';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { StatCard } from '@/components/portal/dashboard/stat-card';
import { deriveOutstandingStat } from '../_lib/dashboard-stats';
import { loadDashboardOutstanding } from './dashboard-reads';

/**
 * 057 portal redesign §4.1 — Outstanding balance stat card section.
 *
 * Resolves the member's issued invoices, derives the outstanding total,
 * and renders a `StatCard`. Adapts to the real StatCard prop interface
 * (no `actionHref` — that is not a StatCard prop; link to invoices is
 * conveyed in the `sub` line and the `variantLabel`).
 *
 * Display-only BE date for th-TH via `getDateFormatLocale` — storage
 * stays UTC Gregorian (Constitution Conventions § Timestamps).
 */

function formatDueDate(ymd: string, locale: string): string {
  return new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString(
    getDateFormatLocale(locale),
    { year: 'numeric', month: 'short', day: 'numeric' },
  );
}

export async function OutstandingStatSection({
  tenantId,
  memberId,
}: {
  readonly tenantId: string;
  readonly memberId: string;
}): Promise<React.JSX.Element> {
  const t = await getTranslations('portal.dashboard.outstanding');
  const locale = await getLocale();
  const invoices = await loadDashboardOutstanding(tenantId, memberId);
  const stat = deriveOutstandingStat(invoices);

  if (stat.kind === 'clear') {
    return (
      <StatCard
        label={t('label')}
        value={t('clearValue')}
        sub={t('clearSub')}
        variant="neutral"
      />
    );
  }

  const sub =
    stat.earliestDueDate !== null
      ? t('dueSub', { date: formatDueDate(stat.earliestDueDate, locale) })
      : t('countSub', { count: stat.count });

  const variantLabel = t('countSub', { count: stat.count });

  return (
    <StatCard
      label={t('label')}
      value={t('value', { amount: formatSatangThb(stat.totalSatang, locale) })}
      sub={sub}
      variant="destructive"
      variantLabel={variantLabel}
    />
  );
}
