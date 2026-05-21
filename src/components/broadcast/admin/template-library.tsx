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
import { useLocale, useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type FilterMode = 'all' | 'starter' | 'authored';

export interface TemplateLibraryRow {
  readonly id: string;
  readonly name: string;
  readonly locale: 'en' | 'th' | 'sv';
  readonly startedFromCount: number;
  readonly isSeeded: boolean;
  readonly updatedAtIso: string;
  /**
   * Subject preview (LOW UX review fix 2026-05-21 + C1 Round 2 wire-up):
   * admin can scan subject lines at-a-glance without opening each
   * template's edit page. Truncated server-side to ≤60 chars + `…`
   * ellipsis on overflow (see `page.tsx:58-78` mapping site). Full
   * subject is visible in the edit form. Field is REQUIRED post-Round-2
   * (page always populates from `tpl.subject` which is non-empty per
   * FR-017); kept as `string | undefined` for graceful degradation when
   * any future consumer constructs a row without going through `page.tsx`.
   */
  readonly subjectPreview: string | undefined;
}

interface Props {
  readonly rows: readonly TemplateLibraryRow[];
}

export function AdminTemplateLibrary({
  rows,
}: Props): React.ReactElement | null {
  const t = useTranslations('admin.broadcasts.templates');
  const locale = useLocale();

  // UX M-2 fix 2026-05-21 (review finding enterprise-ux-designer M-2):
  // mirrors `formatDispatchedAt` pattern from batch-breakdown.tsx —
  // pin Asia/Bangkok TZ + apply Buddhist Era calendar for th-TH so
  // TH admins read 2569 not 2026. Other locales pass through native
  // BCP-47 toLocaleString. Fallback to ISO substring on any
  // Intl.DateTimeFormat throw (extremely rare — bounded by browser
  // Intl support which is ubiquitous since Edge 16+).
  function formatUpdatedAt(iso: string): string {
    try {
      const resolvedLocale = locale === 'th' ? 'th-TH-u-ca-buddhist' : locale;
      return new Date(iso).toLocaleDateString(resolvedLocale, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        timeZone: 'Asia/Bangkok',
      });
    } catch {
      return iso.slice(0, 10);
    }
  }
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
  //
  // Sizing: default (h-9 / 36px) matches the F4 project standard for
  // touch-targets (WCAG 2.5.5 / 2.5.8) and Button height parity with
  // form Inputs. Pre-fix used `size: 'sm'` (h-7 / 28px) which was
  // smaller than every other admin filter row in the codebase.
  const pillClass = (mode: FilterMode): string =>
    filter === mode
      ? buttonVariants()
      : buttonVariants({ variant: 'outline' });

  return (
    <>
      {/* flex-wrap keeps SV labels (~50 chars across 3 pills at
          text-[0.8rem]) from overflowing horizontally on the 320px
          Galaxy S8 baseline viewport. */}
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
      </fieldset>
      {/* R4.3 M-3 — live-count announcement moved OUT of <fieldset>.
          JAWS "forms-mode" semantics treat a fieldset as a form
          container; status announcements nested INSIDE one can be
          dropped on focus-mode toggle. The sibling placement keeps
          the announcement audible across NVDA/JAWS/VoiceOver. */}
      <span role="status" aria-live="polite" className="sr-only">
        {t('filterCount', { count: liveCount })}
      </span>

      <Card>
        <CardContent className="p-0">
          {/* Use the shadcn Table primitive for tokenised row-height,
              consistent cell padding, sticky header, and overflow-x
              wrapping — matching the F4 invoices / credit-notes /
              events admin tables. The pre-fix raw `<table>` skipped
              all of those design-system affordances. */}
          <Table>
            <TableCaption className="sr-only">{t('pageTitle')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('columns.name')}</TableHead>
                <TableHead
                  scope="col"
                  className="hidden lg:table-cell text-caption"
                >
                  {t('columns.subjectPreview')}
                </TableHead>
                <TableHead scope="col">{t('columns.locale')}</TableHead>
                <TableHead
                  scope="col"
                  className="text-right hidden sm:table-cell"
                  aria-label={t('columns.startedFromAria')}
                >
                  {t('columns.startedFrom')}
                </TableHead>
                <TableHead scope="col" className="hidden md:table-cell">
                  {t('columns.updatedAt')}
                </TableHead>
                <TableHead scope="col" className="sr-only">
                  {t('columns.actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((tpl) => (
                <TableRow key={tpl.id}>
                  <TableCell>
                    <span className="font-medium">{tpl.name}</span>
                    {tpl.isSeeded ? (
                      <span
                        className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border border-warning bg-warning-surface text-warning"
                        aria-label={t('starterBadgeAria')}
                      >
                        {t('starterBadge')}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-caption text-muted-foreground">
                    {/*
                      M8 Round 2 fix 2026-05-21 (review finding
                      enterprise-ux-designer M8): `truncate max-w-[24rem]`
                      on `<td>` requires `table-layout: fixed` to take
                      effect; shadcn `Table` uses `auto`. Wrap in a
                      `block` span so the truncate works regardless of
                      table layout. Matches the F4 portal/layout
                      truncate pattern.
                    */}
                    <span className="block truncate max-w-[24rem]">
                      {tpl.subjectPreview ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell className="text-caption text-muted-foreground">
                    {t(`locale.${tpl.locale}`)}
                  </TableCell>
                  <TableCell className="text-right hidden sm:table-cell tabular-nums">
                    {tpl.startedFromCount}
                  </TableCell>
                  <TableCell className="text-caption text-muted-foreground hidden md:table-cell">
                    {formatUpdatedAt(tpl.updatedAtIso)}
                  </TableCell>
                  <TableCell className="text-right">
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
