import { getLocale, getTranslations } from 'next-intl/server';
import { formatSatangThb } from '@/lib/format-thb';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { bangkokLocalDate } from '@/lib/fiscal-year';
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
  const read = await loadDashboardOutstanding(tenantId, memberId);

  // F4 — a failed read shows an "unavailable" state, NEVER a misleading
  // "all paid" (which would hide an overdue balance on a transient failure).
  if (read.error) {
    return (
      <StatCard
        label={t('label')}
        value={t('errorValue')}
        sub={t('errorSub')}
        variant="warning"
        variantLabel={t('errorValue')}
      />
    );
  }

  // Bangkok-local "today" for overdue classification — display/derive only;
  // storage stays UTC Gregorian (Constitution Conventions § Timestamps).
  const todayBkk = bangkokLocalDate(new Date().toISOString());
  const stat = deriveOutstandingStat(read.inputs, todayBkk);

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

  // F6 — when the page cap clipped the result, the count line is a floor.
  const countSub = read.partial
    ? t('countSubPartial', { count: stat.count })
    : t('countSub', { count: stat.count });

  // F5 — split owing into overdue (destructive) vs due-soon (warning). Only
  // a strictly past-due invoice goes red; the net-N window stays a calm
  // warning so the stat does not over-alarm during the normal payment window.
  const isOverdue = stat.kind === 'overdue';

  const sub =
    stat.earliestDueDate !== null
      ? t('dueSub', { date: formatDueDate(stat.earliestDueDate, locale) })
      : countSub;

  const variantLabel = isOverdue
    ? t('overdueSub', { count: stat.overdueCount })
    : countSub;

  return (
    <StatCard
      label={t('label')}
      value={t('value', { amount: formatSatangThb(stat.totalSatang, locale) })}
      sub={sub}
      variant={isOverdue ? 'destructive' : 'warning'}
      variantLabel={variantLabel}
    />
  );
}
