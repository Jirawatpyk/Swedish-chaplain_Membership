'use client';

/**
 * T112 (F7.1a US7) — Admin template library list with filter pills.
 *
 * Client component wrapping the templates table — receives pre-fetched
 * rows from the server page (`/admin/broadcasts/templates/page.tsx`)
 * and applies client-side filtering via 3 toggle pills:
 *   - All — every template (default)
 *   - Starter only — `is_seeded=TRUE`
 *   - Admin-authored — `is_seeded=FALSE`
 *
 * Per critique P6 — surfaces the Starter / Admin-authored distinction
 * prominently so chambers with many custom templates can find their
 * own work quickly without scrolling past 15 seeded rows.
 *
 * a11y:
 *   - <fieldset role="radiogroup"> with <legend> announces the
 *     filter purpose
 *   - aria-pressed on each pill button
 *   - Live region announces the filtered row count after change
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

type FilterMode = 'all' | 'starter' | 'authored';

export interface TemplateLibraryRow {
  readonly id: string;
  readonly name: string;
  readonly locale: 'en' | 'th' | 'sv';
  readonly startedFromCount: number;
  readonly isSeeded: boolean;
  readonly updatedAtIso: string;
}

interface Props {
  readonly rows: readonly TemplateLibraryRow[];
}

export function AdminTemplateLibrary({
  rows,
}: Props): React.ReactElement | null {
  const t = useTranslations('admin.broadcasts.templates');
  const [filter, setFilter] = useState<FilterMode>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return rows;
    return rows.filter((r) =>
      filter === 'starter' ? r.isSeeded : !r.isSeeded,
    );
  }, [rows, filter]);

  // R4-S7 L4 — debounce filter-count announcement by a tick so the
  // screen reader's focus-cue from the aria-pressed pill click lands
  // first; only THEN announce the new filtered count. Without the
  // delay, NVDA + VoiceOver sometimes drop the count update because
  // they're already speaking the new aria-pressed state.
  //
  // Lazy initializer captures the first-render value synchronously
  // (no announcement on mount) — only subsequent filter changes go
  // through the setTimeout(0) defer (react-hooks/set-state-in-effect
  // forbids a synchronous setState inside useEffect, hence the
  // initializer pattern instead of an in-effect first-render branch).
  // Debounce filter-count announcement by 100ms so the screen
  // reader's focus-cue from the aria-pressed pill click lands first.
  // NVDA debounces ~50ms; VoiceOver ~100ms. Lazy initializer
  // captures first-render synchronously (no announcement on mount).
  const [liveCount, setLiveCount] = useState<number>(() => filtered.length);
  useEffect(() => {
    const id = setTimeout(() => setLiveCount(filtered.length), 100);
    return () => clearTimeout(id);
  }, [filtered.length]);

  if (rows.length === 0) {
    // Empty state stays in the parent (server page) — this component
    // is only mounted when there's data to filter.
    return null;
  }

  // Inline pill renderer — React 19's `react-hooks/static-components`
  // rule blocks defining a component inside another component, and
  // pulling FilterPill to module-level would force threading `t` +
  // `filter` + `setFilter` through props. The literal 3-button JSX
  // below stays under 30 lines and keeps the parent function readable.
  const pillClass = (mode: FilterMode): string =>
    filter === mode
      ? buttonVariants({ size: 'sm' })
      : buttonVariants({ variant: 'outline', size: 'sm' });

  return (
    <>
      {/* R3.6 L-5 — flex-wrap added so SV labels (~50 chars across
          3 pills at text-[0.8rem]) don't overflow horizontally on
          320px Galaxy S8 baseline viewport. */}
      <fieldset className="mb-4 flex flex-wrap items-center gap-2">
        <legend className="sr-only">{t('filterLegend')}</legend>
        <button
          type="button"
          onClick={() => setFilter('all')}
          aria-pressed={filter === 'all'}
          className={pillClass('all')}
        >
          {t('filterPill.all')}
        </button>
        <button
          type="button"
          onClick={() => setFilter('starter')}
          aria-pressed={filter === 'starter'}
          className={pillClass('starter')}
        >
          {t('filterPill.starter')}
        </button>
        <button
          type="button"
          onClick={() => setFilter('authored')}
          aria-pressed={filter === 'authored'}
          className={pillClass('authored')}
        >
          {t('filterPill.authored')}
        </button>
        <span role="status" aria-live="polite" className="sr-only">
          {t('filterCount', { count: liveCount })}
        </span>
      </fieldset>

      <Card>
        <CardContent className="p-0">
          <table className="w-full border-collapse">
            <caption className="sr-only">{t('pageTitle')}</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="text-left p-3">
                  {t('columns.name')}
                </th>
                <th scope="col" className="text-left p-3">
                  {t('columns.locale')}
                </th>
                <th
                  scope="col"
                  className="text-right p-3 hidden sm:table-cell"
                  aria-label={t('columns.startedFromAria')}
                >
                  {t('columns.startedFrom')}
                </th>
                <th scope="col" className="text-left p-3 hidden md:table-cell">
                  {t('columns.updatedAt')}
                </th>
                <th scope="col" className="sr-only">
                  {t('columns.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tpl) => (
                <tr key={tpl.id} className="border-b last:border-b-0">
                  <td className="p-3">
                    <span className="font-medium">{tpl.name}</span>
                    {tpl.isSeeded ? (
                      <span
                        className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border border-warning bg-warning-surface text-warning"
                        aria-label={t('starterBadgeAria')}
                      >
                        {t('starterBadge')}
                      </span>
                    ) : null}
                  </td>
                  <td className="p-3 text-caption text-muted-foreground">
                    {t(`locale.${tpl.locale}`)}
                  </td>
                  <td className="p-3 text-right hidden sm:table-cell tabular-nums">
                    {tpl.startedFromCount}
                  </td>
                  <td className="p-3 text-caption text-muted-foreground hidden md:table-cell">
                    {tpl.updatedAtIso.slice(0, 10)}
                  </td>
                  <td className="p-3 text-right">
                    <Link
                      href={`/admin/broadcasts/templates/${tpl.id}/edit`}
                      className={buttonVariants({
                        variant: 'ghost',
                        size: 'sm',
                      })}
                      aria-label={t('rowAction.editAria', {
                        name: tpl.name,
                      })}
                    >
                      {t('rowAction.edit')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}
