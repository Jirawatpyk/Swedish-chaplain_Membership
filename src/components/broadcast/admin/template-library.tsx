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
 *   - a <fieldset> with an sr-only <legend> names the filter group (the
 *     pills are toggle buttons, not a radiogroup)
 *   - aria-pressed on each pill button
 *   - Live region announces the filtered row count after change; the
 *     visible count beside the pills is aria-hidden so it is said once
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import {
  Badge,
  Card,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  Tag,
  buttonClass,
} from '@jirawatpyk/aura-react';

type FilterMode = 'all' | 'starter' | 'authored';

/**
 * The subject follows the table box, not the viewport: it steps aside in a
 * narrow grid (up to 820px: a tablet, or a 1024 laptop beside the sidebar),
 * is cut at 12rem up to 1000px (a tablet in landscape), and at 24rem beyond;
 * the phone card shows it whole. Text cells
 * in the grid wrap between words only, so AURA's `overflow-wrap: anywhere`
 * cannot squeeze a name to a few letters a line; phone cards keep it
 * (stand-in until AURA #174).
 */
const GRID_WORD_WRAP = '@min-[640px]/aura-tbl:[overflow-wrap:normal]';
const HIDE_IN_NARROW_GRID = '@min-[640px]/aura-tbl:@max-[820px]/aura-tbl:hidden';

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
  // Locale labels moved to the single-source `common.languageOptions` (i18n
  // dedup); the old `admin.broadcasts.templates.locale.{en,th,sv}` sub-object
  // was removed, so read from `common` like template-form.tsx does — else
  // every template row throws MISSING_MESSAGE at runtime.
  const tLang = useTranslations('common');
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
      return new Date(iso).toLocaleDateString(getDateFormatLocale(locale), {
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

  // The pills are AURA selectable tags (spec 122 US12a): each is a
  // `<button aria-pressed>` that shows a check while it is on, as the
  // board draws them. React 19's `react-hooks/static-components` rule keeps
  // the three literal tags inline rather than in a nested component.
  // Below 640px the rows are cards of their own, so the outer card's frame
  // drops away (AURA `flushBelow`), as the phone board draws it.
  return (
    <Card flushBelow="sm" className="max-sm:p-0">
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        {/* flex-wrap keeps SV labels from overflowing on a 320px phone. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">{t('filterLegend')}</legend>
            <Tag
              selected={filter === 'all'}
              onClick={() => setFilter('all')}
              touchHeight
            >
              {t('filterPill.all')}
            </Tag>
            <Tag
              selected={filter === 'starter'}
              onClick={() => setFilter('starter')}
              touchHeight
            >
              {t('filterPill.starter')}
            </Tag>
            <Tag
              selected={filter === 'authored'}
              onClick={() => setFilter('authored')}
              touchHeight
            >
              {t('filterPill.authored')}
            </Tag>
          </fieldset>
          {/* UX L1 — the count the eye reads; the debounced status below is
              what a screen reader hears, so this one is hidden from it. */}
          <span
            data-slot="template-count"
            aria-hidden="true"
            className="aura-text-caption text-[var(--aura-fg-secondary)] sm:ml-auto"
          >
            {t('filterCount', { count: filtered.length })}
          </span>
        </div>
        {/* R4.3 M-3 — the live count stays OUTSIDE the <fieldset>: JAWS
            forms mode can drop a status nested inside one. */}
        <span role="status" aria-live="polite" className="sr-only">
          {t('filterCount', { count: liveCount })}
        </span>

        <Table
          caption={t('pageTitle')}
          captionHidden
          stackBelow="sm"
          stackStyle="cards"
          align="middle"
          bleed
          bleedEnd
        >
          <THead>
            <Tr>
              <Th scope="col">{t('columns.name')}</Th>
              <Th scope="col" className={HIDE_IN_NARROW_GRID}>
                {t('columns.subjectPreview')}
              </Th>
              <Th scope="col">{t('columns.locale')}</Th>
              <Th scope="col" numeric aria-label={t('columns.startedFromAria')}>
                {t('columns.startedFrom')}
              </Th>
              <Th scope="col">{t('columns.updatedAt')}</Th>
              <Th scope="col">
                <span className="sr-only">{t('columns.actions')}</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {filtered.length === 0 ? (
              // Filter matched nothing (e.g. "Admin-authored" when every
              // template is a Starter); the page-level empty state only
              // covers "zero templates at all".
              <Tr>
                <Td colSpan={6} label="" align="center" className="py-8 text-[var(--aura-fg-secondary)]">
                  {t('filterEmpty')}
                </Td>
              </Tr>
            ) : (
              filtered.map((tpl) => (
                <Tr key={tpl.id}>
                  <Td card="title" className={GRID_WORD_WRAP}>
                    {/* Board parity: on a phone card the badge sits at the
                        right end of the title row; in the table it follows
                        the name. */}
                    <span className="inline-flex flex-wrap items-center gap-2 max-sm:flex max-sm:w-full max-sm:flex-nowrap max-sm:items-start max-sm:justify-between">
                      <span className="min-w-0 font-medium">{tpl.name}</span>
                      {tpl.isSeeded ? (
                        // UX L3 — a span cannot carry an aria-label, so the
                        // fuller name rides in sr-only text.
                        <Badge tone="warning" className="shrink-0">
                          <span aria-hidden="true">{t('starterBadge')}</span>
                          <span className="sr-only">{t('starterBadgeAria')}</span>
                        </Badge>
                      ) : null}
                    </span>
                  </Td>
                  <Td className={`text-[var(--aura-fg-secondary)] ${HIDE_IN_NARROW_GRID}`}>
                    {/* A block span so `truncate` works under the table's
                        auto layout (M8 Round 2); on a phone card the subject
                        wraps instead of being cut (UX M2). */}
                    <span className="block max-sm:[overflow-wrap:anywhere] sm:max-w-[24rem] sm:truncate @min-[821px]/aura-tbl:@max-[1000px]/aura-tbl:max-w-[12rem]">
                      {tpl.subjectPreview ?? '—'}
                    </span>
                  </Td>
                  <Td className={`text-[var(--aura-fg-secondary)] ${GRID_WORD_WRAP}`}>
                    {tLang(`languageOptions.${tpl.locale}`)}
                  </Td>
                  <Td numeric>{tpl.startedFromCount}</Td>
                  <Td className="text-[var(--aura-fg-secondary)]">
                    {formatUpdatedAt(tpl.updatedAtIso)}
                  </Td>
                  {/* Board parity: on a phone card Edit is a full-width outline
                      button at the foot (an unlabelled field spanning the
                      card); from 640px it is the ghost link in the row. Only
                      one of the two is ever displayed. */}
                  <Td label="" align="end" className="max-sm:basis-full">
                    <Link
                      data-edit="phone"
                      href={`/admin/broadcasts/templates/${tpl.id}/edit`}
                      className={`${buttonClass({ variant: 'secondary', touchHeight: true })} w-full sm:hidden`}
                      aria-label={t('rowAction.editAria', { name: tpl.name })}
                    >
                      {t('rowAction.edit')}
                    </Link>
                    <Link
                      data-edit="desktop"
                      href={`/admin/broadcasts/templates/${tpl.id}/edit`}
                      className={`${buttonClass({ variant: 'ghost', touchHeight: true })} max-sm:hidden`}
                      aria-label={t('rowAction.editAria', { name: tpl.name })}
                    >
                      {t('rowAction.edit')}
                    </Link>
                  </Td>
                </Tr>
              ))
            )}
          </TBody>
        </Table>
      </div>
    </Card>
  );
}
