/**
 * 124 — the invoice dashboard's render, split from `page.tsx` so the no-DB
 * preview route draws the same tree from fixtures (each loader result may be
 * a value or the page's still-running promise). The page keeps the guards,
 * the clock and the loaders; this lays out what it hands over.
 *
 * Layout (boards `Admin-finance*`): header, filters, the four tiles, then
 * Unpaid by age + Needs attention, Oldest overdue, Billed vs collected +
 * By payment method. Below 1024px the cards stack in the mobile board's
 * order: Needs attention first. Each card streams in its own Suspense island
 * and fails alone (US5.3). With no invoice ever issued the page shows one
 * empty state instead (US5.2); a filter that matches nothing never does.
 */
import type { ComponentProps, ReactNode } from 'react';
import { Suspense } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, EmptyState, Stat, buttonClass } from '@jirawatpyk/aura-react/server';
import type { FiscalYearStartMonth } from '@/lib/fiscal-year';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CountUp } from '@/components/dashboard/count-up';
import {
  fiscalYearDateRange,
  invoiceListFilterQuery,
  selectableFiscalYears,
  type InvoiceDashboardAging,
  type InvoiceDashboardAttention,
  type InvoiceDashboardLoadInput,
  type InvoiceDashboardMethods,
  type InvoiceDashboardOldestOverdue,
  type InvoiceDashboardResult,
  type InvoiceDashboardTiles,
  type InvoiceDashboardTrend,
} from '@/modules/insights';
import { exportCsvHref, invoiceListHref } from '../_lib/dashboard-links';
import { formatDay, formatMonthLong, formatMonthShort, formatYear, toBaht } from '../_lib/dashboard-format';
import { AgingCard } from './aging-card';
import { AttentionCard } from './attention-card';
import { CardError, CardSkeleton } from './card-states';
import { DashboardFilters } from './dashboard-filters';
import { DashboardHeaderActions } from './dashboard-header-actions';
import { MethodsCard } from './methods-card';
import { OldestOverdueCard } from './oldest-overdue-card';
import { TrendCard } from './trend-card';

type Loaded<T> = InvoiceDashboardResult<T> | Promise<InvoiceDashboardResult<T>>;

export interface InvoiceDashboardViewProps {
  readonly locale: string;
  /** The request instant (the "As of" line). */
  readonly now: Date;
  readonly input: InvoiceDashboardLoadInput;
  readonly currentFiscalYear: number;
  readonly startMonth: FiscalYearStartMonth;
  readonly autoInvoiceEnabled: boolean;
  /** This year's active plans, labelled in the viewer's locale. */
  readonly plans: readonly { readonly id: string; readonly label: string }[];
  /** Awaited by the page: the tiles decide the "No invoices yet" state. */
  readonly tiles: InvoiceDashboardResult<InvoiceDashboardTiles>;
  readonly aging: Loaded<InvoiceDashboardAging>;
  readonly attention: Loaded<InvoiceDashboardAttention>;
  readonly oldestOverdue: Loaded<InvoiceDashboardOldestOverdue>;
  readonly trend: Loaded<InvoiceDashboardTrend>;
  readonly methods: Loaded<InvoiceDashboardMethods>;
}

const TILE_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-4 sm:grid-cols-2 lg:grid-cols-4';
/**
 * The amount stays on one line, so every tile's caption starts at the same
 * height. A tile narrower than 16rem (four across beside the sidebar at
 * 1280px) steps the amount down a size instead of wrapping "THB" onto its own
 * line; the phone tiles keep their compact amount at full size.
 */
const TILE_AMOUNT = 'whitespace-nowrap sm:@max-[16rem]:text-[1.375rem]';

export async function renderInvoiceDashboardView(props: InvoiceDashboardViewProps): Promise<ReactNode> {
  const { locale, now, input, currentFiscalYear, startMonth, autoInvoiceEnabled, plans, tiles } = props;
  const t = await getTranslations('admin.invoiceDashboard');
  const { filters, today } = input;

  const fyLabel = (fy: number) => {
    const range = fiscalYearDateRange(fy, startMonth);
    return t('fiscalYearLabel', {
      year: formatYear(fy, locale),
      fromMonth: formatMonthShort(range.from, locale),
      toMonth: formatMonthShort(range.to, locale),
    });
  };
  const fiscalYearShort = t('fiscalYearShort', { year: formatYear(filters.fiscalYear, locale) });
  const filtered = filters.type !== 'all' || filters.planId !== null || filters.origin !== 'all';
  const listFilters = invoiceListFilterQuery(filters);
  const noInvoicesYet = tiles.ok && !tiles.value.anyNonDraftInvoice;

  // The boards' "· 3 drafts not counted": every draft under the filters is
  // left out of every figure; the note shows only when there is one.
  const drafts = tiles.ok ? tiles.value.draftsNotCounted : 0;
  const draftsNote = drafts > 0 ? ` · ${t('draftsNotCounted', { count: drafts })}` : '';
  const header = (
    <PageHeader
      title={t('title')}
      subtitle={
        noInvoicesYet
          ? t('asOfEmpty', { fiscalYear: fyLabel(filters.fiscalYear) })
          : t('asOf', {
              dateTime: formatLocalisedDate(now, locale, { dateStyle: 'medium', timeStyle: 'short' }),
              fiscalYear: fyLabel(filters.fiscalYear),
            }) + draftsNote
      }
      actions={
        noInvoicesYet ? null : (
          <DashboardHeaderActions
            exportHref={exportCsvHref(input.fiscalYearRange, today)}
            invoicesHref={invoiceListHref(listFilters)}
            exportLabel={t('actions.exportCsv')}
            viewInvoicesLabel={t('actions.viewInvoices')}
            moreLabel={t('actions.more')}
          />
        )
      }
    />
  );
  const filterBar = (
    <DashboardFilters
      values={filters}
      currentFiscalYear={currentFiscalYear}
      fiscalYears={selectableFiscalYears(currentFiscalYear).map((fy) => ({ value: fy, label: fyLabel(fy) }))}
      plans={plans}
      showOrigin={autoInvoiceEnabled}
    />
  );

  if (noInvoicesYet) {
    return (
      <DetailContainer>
        {header}
        {/* Nothing to filter yet: shown, but out of reach (US5.2). */}
        <div inert className="opacity-55" data-testid="dashboard-filters-disabled">
          {filterBar}
        </div>
        <EmptyState
          bordered
          icon="file-text"
          headingLevel={2}
          title={t('states.emptyTitle')}
          description={t('states.emptyDescription')}
          data-testid="dashboard-empty"
          {...(input.canWrite
            ? {
                action: (
                  <Link href="/admin/invoices/new" className={buttonClass({ variant: 'primary' })}>
                    {t('states.newInvoice')}
                  </Link>
                ),
              }
            : {})}
        />
      </DetailContainer>
    );
  }

  return (
    <DetailContainer>
      {header}
      {filterBar}
      {tiles.ok ? (
        <TileRow tiles={tiles.value} t={t} locale={locale} listFilters={listFilters} fiscalYearShort={fiscalYearShort} today={today} />
      ) : (
        <Card title={t('tiles.title')} headingLevel={2}>
          <CardError
            copy={{
              title: t('states.cardError', { card: t('tiles.title') }),
              description: t('states.cardErrorDescription', { referenceId: tiles.error.referenceId }),
              tryAgain: t('states.tryAgain'),
            }}
          />
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-10">
        <div className="order-2 lg:order-none lg:col-span-5">
          <Suspense fallback={<CardSkeleton loadingLabel={t('states.loadingCard')} kind="aging" title={t('aging.title')} description={t('aging.description')} />}>
            <AgingCard result={props.aging} filtered={filtered} />
          </Suspense>
        </div>
        <div className="order-1 lg:order-none lg:col-span-5">
          <Suspense fallback={<CardSkeleton loadingLabel={t('states.loadingCard')} kind="attention" title={t('attention.title')} />}>
            <AttentionCard
              result={props.attention}
              filtered={filtered}
              listFilters={listFilters}
              linkDrafts={autoInvoiceEnabled}
            />
          </Suspense>
        </div>
        <div className="order-3 lg:order-none lg:col-span-10">
          <Suspense fallback={<CardSkeleton loadingLabel={t('states.loadingCard')} kind="oldestOverdue" title={t('oldest.title')} description={t('oldest.description')} />}>
            <OldestOverdueCard
              result={props.oldestOverdue}
              overdueCount={tiles.ok ? tiles.value.overdue.count : null}
              filtered={filtered}
              listFilters={listFilters}
              locale={locale}
              today={today}
            />
          </Suspense>
        </div>
        <div className="order-4 lg:order-none lg:col-span-6">
          <Suspense fallback={<CardSkeleton loadingLabel={t('states.loadingCard')} kind="trend" title={t('trend.title')} />}>
            <TrendCard result={props.trend} locale={locale} fiscalYearShort={fiscalYearShort} filtered={filtered} />
          </Suspense>
        </div>
        <div className="order-5 lg:order-none lg:col-span-4">
          <Suspense fallback={<CardSkeleton loadingLabel={t('states.loadingCard')} kind="methods" title={t('methods.title')} />}>
            <MethodsCard result={props.methods} filtered={filtered} fiscalYearShort={fiscalYearShort} />
          </Suspense>
        </div>
      </div>
    </DetailContainer>
  );
}

/** One key-figure tile: AURA's Stat in its own size container (TILE_AMOUNT). */
function Tile(props: ComponentProps<typeof Stat>) {
  return (
    <div className="@container">
      <Stat {...props} className="h-full" />
    </div>
  );
}

type DashboardT = Awaited<ReturnType<typeof getTranslations<'admin.invoiceDashboard'>>>;

/**
 * The four key figures (US1.1–1.5). Outstanding and Overdue link to the list
 * they count (US2.1); the Collected tiles have no list of their own.
 */
function TileRow({
  tiles,
  t,
  locale,
  listFilters,
  fiscalYearShort,
  today,
}: {
  readonly tiles: InvoiceDashboardTiles;
  readonly t: DashboardT;
  readonly locale: string;
  readonly listFilters: ReturnType<typeof invoiceListFilterQuery>;
  readonly fiscalYearShort: string;
  readonly today: string;
}) {
  const fy = tiles.collectedInFiscalYear;
  const money = (satang: bigint) => (
    <CountUp value={toBaht(satang)} locale={locale} variant="thb" compactBelowSm className={TILE_AMOUNT} />
  );
  return (
    <section aria-label={t('tiles.sectionLabel')} className={TILE_GRID} data-testid="dashboard-tiles">
      <Tile
        label={t('tiles.outstanding')}
        caption={t('tiles.outstandingCaption', { count: tiles.outstanding.count })}
        icon="file-text"
        href={invoiceListHref({ status: 'issued', ...listFilters })}
        value={money(tiles.outstanding.amountSatang)}
      />
      <Tile
        label={t('tiles.overdue')}
        caption={t('tiles.overdueCaption', { count: tiles.overdue.count })}
        icon="triangle-alert"
        href={invoiceListHref({ status: 'overdue', ...listFilters })}
        value={money(tiles.overdue.amountSatang)}
      />
      <Tile
        label={t('tiles.collectedMonth')}
        caption={t('tiles.collectedMonthCaption', { month: formatMonthLong(today, locale) })}
        icon="circle-check"
        value={money(tiles.collectedThisMonth.amountSatang)}
      />
      <Tile
        label={t('tiles.collectedFiscalYear', { fiscalYear: fiscalYearShort })}
        caption={
          fy.toDate
            ? t('tiles.collectedFiscalYearToDate', { fiscalYear: fiscalYearShort })
            : t('tiles.collectedFiscalYearWhole', {
                fiscalYear: fiscalYearShort,
                from: formatDay(fy.range.from, locale),
                to: formatDay(fy.range.to, locale),
              })
        }
        icon="trending-up"
        value={money(fy.amountSatang)}
      />
    </section>
  );
}
