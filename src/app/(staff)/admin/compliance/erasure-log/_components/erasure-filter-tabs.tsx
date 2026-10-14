'use client';

/**
 * Erasure-log UX enhancement — Task 4: `ErasureFilterTabs`.
 *
 * Status-filter nav strip (All / Overdue / In progress / Complete) rendered
 * above the erasure-log card list. These entries NAVIGATE to a different
 * `?status=` query value on the SAME route, so they are real navigation links
 * inside a `<nav>` landmark, NOT an ARIA tablist (there is no
 * `role="tabpanel"` for a tab role to control). `active` is a prop derived
 * from the page's own `searchParams`.
 *
 * Spec 122 US10b (T1014; board `Admin-erasure-log`): AURA link `Tabs` (a nav
 * of links with `aria-current="page"` on the current one), each with its
 * count. Each link is named by its label then the count in words ("Overdue,
 * 1 erasure"), so the name starts with the visible label (WCAG 2.5.3). The
 * Overdue tab keeps its warning icon while it has erasures; the board draws
 * an inactive tab's text plain, so the old red tint goes.
 */
import { AlertTriangleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Tabs, type TabItem } from '@jirawatpyk/aura-react';
import type { ErasureStatusFilter, ErasureLogSummary } from '@/modules/insights';

const BASE = '/admin/compliance/erasure-log';

function hrefFor(value: ErasureStatusFilter, q: string): string {
  const params = new URLSearchParams();
  if (value !== 'all') params.set('status', value);
  if (q !== '') params.set('q', q);
  const qs = params.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

export function ErasureFilterTabs({
  active,
  summary,
  q,
}: {
  readonly active: ErasureStatusFilter;
  readonly summary: ErasureLogSummary;
  readonly q: string;
}): React.JSX.Element {
  const t = useTranslations('admin.compliance.erasureLog');
  const items: ReadonlyArray<{
    readonly value: ErasureStatusFilter;
    readonly label: string;
    readonly count: number;
  }> = [
    { value: 'all', label: t('filter.all'), count: summary.total },
    { value: 'overdue', label: t('filter.overdue'), count: summary.overdue },
    { value: 'in_progress', label: t('filter.inProgress'), count: summary.inProgress },
    { value: 'complete', label: t('filter.complete'), count: summary.complete },
  ];

  const tabs: TabItem[] = items.map((item) => ({
    id: item.value,
    label: item.label,
    count: item.count,
    href: hrefFor(item.value, q),
    ...(item.value === 'overdue' && summary.overdue > 0
      ? { icon: <AlertTriangleIcon aria-hidden data-testid="overdue-warning" /> }
      : {}),
    tabProps: { 'aria-label': `${item.label}, ${t('filter.countSr', { count: item.count })}` },
  }));

  return (
    <div className="min-w-0 overflow-x-auto">
      <Tabs touchHeight label={t('filter.navLabel')} tabs={tabs} value={active} />
    </div>
  );
}
