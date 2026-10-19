/**
 * Spec 122 US12a (T1208) — the marketing audience's presentation, split out
 * of `page.tsx` so the preview harness can render it with fixtures. The page
 * keeps the guards, the parsing and the reads; nothing here fetches.
 */
import { Suspense } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { SearchXIcon, UsersIcon } from 'lucide-react';
import { Alert, Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { AUDIENCE_COUNT_ID, MARKETING_AUDIENCE_PREFLIGHT_QUERY } from '@/lib/marketing-audience-filter';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { EmptyState } from '@/components/shell/empty-state';
import { ReadOnlyBanner } from '@/components/shell/read-only-banner';
import { AudienceFilters } from './audience-filters';
import { AudienceTable, type AudienceTableRow } from './audience-table';
import { AudienceFiltersSkeleton } from './audience-table-skeleton';

export const AUDIENCE_HREF = '/admin/marketing/audience';

/**
 * The page frame: header with the pre-flight preset, the card, the read-only
 * note and the filters. The page wraps it in its `TableContainer`
 * (check:layout pairs the page with its loading file).
 */
export async function AudienceFrame({
  canMarketing,
  presetActive,
  children,
}: {
  readonly canMarketing: boolean;
  readonly presetActive: boolean;
  readonly children: React.ReactNode;
}) {
  const t = await getTranslations('admin.marketing.audience');
  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link
            href={`${AUDIENCE_HREF}?${MARKETING_AUDIENCE_PREFLIGHT_QUERY}`}
            // A header action carrying a TRANSLATED label must be allowed to
            // wrap: the SV string is wider than a 320-px content box
            // (FR-035c / FR-050a).
            className={cn(
              buttonClass({ variant: 'secondary', touchHeight: true }),
              'h-auto min-h-11 whitespace-normal py-2 text-center sm:min-h-9',
            )}
            aria-current={presetActive ? 'page' : undefined}
            data-testid="audience-preflight-preset"
          >
            {t('preflightPreset')}
          </Link>
        }
      />
      {/* Below 640px the contacts are cards of their own, so the frame and
          its padding drop away (AURA `flushBelow`), as the phone board draws it. */}
      <Card flushBelow="sm" className="max-sm:p-0">
        {/* From 640px the count (the results' own line, which streams in after
            the filters) sits at the end of the filter row when it fits, as the
            result count does on every list: the body wraps, the filters take
            their one-row width as a basis, so the count joins their row on a
            wide card and drops under them, never squeezing the bar, on a
            narrower one; everything else takes a full row. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:[&>*]:basis-full sm:[&>*]:min-w-0 sm:[&>[data-audience-filters]]:grow sm:[&>[data-audience-filters]]:basis-[max-content] sm:[&>#audience-count]:basis-auto sm:[&>#audience-count]:whitespace-nowrap">
          {!canMarketing && (
            <ReadOnlyBanner data-testid="audience-read-only">{t('readOnly')}</ReadOnlyBanner>
          )}
          {/* `useSearchParams` in the filters needs a Suspense boundary so the
              route keeps server rendering. */}
          <Suspense fallback={<AudienceFiltersSkeleton />}>
            <AudienceFilters />
          </Suspense>
          {children}
        </div>
      </Card>
    </>
  );
}


/** The results: the count line, the degraded note, the empty states, or the table and pagination. */
export async function AudienceResults({
  rows: tableRows,
  total,
  page,
  pageSize,
  narrowed,
  degraded,
  canMarketing,
  leavesView,
}: {
  readonly rows: readonly AudienceTableRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly narrowed: boolean;
  readonly degraded: boolean;
  readonly canMarketing: boolean;
  /** A state-filtered view drops a row the moment its state changes (H4). */
  readonly leavesView: boolean;
}) {
  const t = await getTranslations('admin.marketing.audience');
  // A degraded read that found nothing is NOT "nothing matches" — the list
  // could not be read (review M4): the panel below is the whole story.
  const degradedEmpty = degraded && total === 0;

  return (
    <>
      {/* FR-040-style honesty for the count: announced to AT on every filter
          change — the ONE live region here (pagination is silenced, L2; the
          degraded panel is a note; at ZERO the EmptyState is the one
          announcement, so the count line stays visible but is not live —
          M-14). Always rendered: it is the focus fallback when the LAST row
          leaves a filtered view (H4) — at that moment total is 0. */}
      {!degradedEmpty && (
        <p
          id={AUDIENCE_COUNT_ID}
          tabIndex={-1}
          className="aura-text-body text-[var(--aura-fg-secondary)] outline-none"
          {...(total > 0 ? { role: 'status', 'aria-live': 'polite' as const } : {})}
          data-testid="audience-count"
        >
          {narrowed ? t('count', { count: total }) : t('countAll', { count: total })}
        </p>
      )}

      {degraded && (
        <Alert
          tone="warning"
          role="note"
          title={t('empty.unavailable.title')}
          data-testid="audience-degraded"
        >
          {t('empty.unavailable.description')}
        </Alert>
      )}

      {degradedEmpty ? null : total === 0 ? (
        narrowed ? (
          <EmptyState
            icon={SearchXIcon}
            title={t('empty.filtered.title')}
            description={t('empty.filtered.description')}
            bordered={false}
            data-testid="audience-empty-filtered"
            action={
              // Clearing must LIFT the default eligibility leg too, or a
              // tenant whose members are all inactive lands back on the same
              // empty page (review code M1).
              <Link
                href={`${AUDIENCE_HREF}?eligible=0`}
                className={buttonClass({ variant: 'secondary', touchHeight: true })}
              >
                {t('empty.filtered.cta')}
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={UsersIcon}
            title={t('empty.none.title')}
            description={t('empty.none.description')}
            bordered={false}
            data-testid="audience-empty-none"
          />
        )
      ) : (
        <>
          <AudienceTable rows={tableRows} canMarketing={canMarketing} leavesView={leavesView} />
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            baseHref={AUDIENCE_HREF}
            live={false}
          />
        </>
      )}
    </>
  );
}
