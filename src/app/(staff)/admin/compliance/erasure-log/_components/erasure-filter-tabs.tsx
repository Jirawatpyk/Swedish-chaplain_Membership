/**
 * Erasure-log UX enhancement — Task 4: `ErasureFilterTabs`.
 *
 * Status-filter nav strip (All / Overdue / In progress / Complete) rendered
 * above the erasure-log card list. These entries NAVIGATE to a different
 * `?status=` query value on the SAME route, so — mirroring the pattern
 * established by `renewals-section-tabs.tsx` — they are real navigation
 * `<Link>`s inside a `<nav>` landmark, NOT an ARIA tablist (there is no
 * `role="tabpanel"` for a tab role to control).
 *
 * Server Component: `active` is a prop derived from the page's own
 * `searchParams`, not `usePathname()`/`useSearchParams()` — this component
 * never needs `'use client'`.
 *
 * Styling constants (`NAV_LIST`/`NAV_LINK_BASE`/`NAV_LINK_INACTIVE`/
 * `NAV_LINK_ACTIVE`) and the horizontal-scroll wrapper are ported from
 * `renewals-section-tabs.tsx` for pixel-parity with that pattern. The count
 * badge is a LOCAL `CountBadge` (not the renewals `TabCountBadge`) to avoid
 * a cross-route import — it additionally supports a `destructive` tone for
 * the overdue bucket, which `TabCountBadge` does not need.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangleIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ErasureStatusFilter, ErasureLogSummary } from '@/modules/insights';

const BASE = '/admin/compliance/erasure-log';

const NAV_LIST =
  'inline-flex h-8 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground pointer-coarse:h-auto';

const NAV_LINK_BASE =
  'relative inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 rounded-md border border-transparent px-2.5 py-0.5 text-sm font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring pointer-coarse:min-h-11';

const NAV_LINK_INACTIVE =
  'text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground';

const NAV_LINK_ACTIVE =
  'bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30 dark:text-foreground';

function CountBadge({
  count,
  srLabel,
  destructive,
}: {
  readonly count: number;
  readonly srLabel: string;
  readonly destructive?: boolean;
}) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-xs font-medium tabular-nums ring-1 ring-inset',
          destructive
            ? 'bg-destructive/10 text-destructive ring-destructive/20'
            : 'bg-primary/10 text-primary ring-primary/20',
        )}
      >
        {count}
      </span>
      <span className="sr-only"> {srLabel}</span>
    </>
  );
}

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

  return (
    <div className="-my-1 min-w-0 overflow-x-auto overflow-y-hidden py-1">
      <nav aria-label={t('filter.navLabel')} className={NAV_LIST}>
        {items.map((item) => {
          const isActive = item.value === active;
          const showDanger = item.value === 'overdue' && summary.overdue > 0;
          return (
            <Link
              key={item.value}
              href={hrefFor(item.value, q)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                NAV_LINK_BASE,
                isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE,
                showDanger &&
                  !isActive &&
                  'text-destructive hover:text-destructive dark:text-destructive',
              )}
            >
              {showDanger ? (
                <AlertTriangleIcon
                  aria-hidden
                  data-testid="overdue-warning"
                  className="size-3.5"
                />
              ) : null}
              {item.label}
              <CountBadge
                count={item.count}
                destructive={showDanger}
                srLabel={t('filter.countSr', { count: item.count })}
              />
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
