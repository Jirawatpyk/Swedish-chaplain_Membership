/**
 * 124 — Billed vs collected, by month of the selected FY (spec § Figure
 * definitions, D-e, D-g). Billed is by issue date with voided invoices left
 * out, less credit notes issued that month; Collected is the document basis,
 * read to today in the current FY. The caption starts with the FY label
 * (US3.3), says a past month can change when one of its invoices is voided,
 * and points to the tax-document register for VAT: this is a billing view,
 * not the ภ.พ.30 basis. The words "revenue" and "net of credit notes" are not
 * used. The bars are decorative; the sr-only table is the reading.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { ChartDataTable } from '@/components/dashboard/chart-data-table';
import type { InvoiceDashboardResult, InvoiceDashboardTrend } from '@/modules/insights';
import { formatAmount, formatMonthLong, formatMonthShort, formatMonthYear, toBaht } from '../_lib/dashboard-format';
import { BILLED_SERIES, COLLECTED_SERIES } from '../_lib/trend-series';
import { CardError } from './card-states';
import { TrendChart } from './trend-chart';
import type { TrendChartPoint } from './trend-chart-canvas';

function Swatch({ color, light = false }: { readonly color: string; readonly light?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 rounded-[2px]"
      style={{ background: color, opacity: light ? 0.6 : 1 }}
    />
  );
}

export async function TrendCard({
  result,
  locale,
  fiscalYearShort,
}: {
  readonly result: Promise<InvoiceDashboardResult<InvoiceDashboardTrend>> | InvoiceDashboardResult<InvoiceDashboardTrend>;
  readonly locale: string;
  /** "FY 2026", the caption's first words (US3.3). */
  readonly fiscalYearShort: string;
}) {
  const t = await getTranslations('admin.invoiceDashboard');
  const loaded = await result;
  const title = t('trend.title');
  const description = t('trend.description', { fiscalYear: fiscalYearShort });
  if (!loaded.ok) {
    return (
      <Card title={title} description={description} headingLevel={2}>
        <CardError
          copy={{
            title: t('states.cardError', { card: title }),
            description: t('states.cardErrorDescription', { referenceId: loaded.error.referenceId }),
            tryAgain: t('states.tryAgain'),
          }}
        />
      </Card>
    );
  }
  const trend = loaded.value;
  const slots = trend.slots;
  const known = slots.filter((s) => s.state !== 'future');
  const billedTotal = known.reduce((sum, s) => sum + (s.billedSatang ?? 0n), 0n);
  const collectedTotal = known.reduce((sum, s) => sum + (s.collectedSatang ?? 0n), 0n);
  const range = `${formatMonthShort(trend.range.from, locale)}–${formatMonthShort(trend.collectedRange.to, locale)}`;
  const current = slots.find((s) => s.state === 'current');
  const future = slots.filter((s) => s.state === 'future');
  const firstFuture = future[0];
  const lastFuture = future.at(-1);
  const futureLabel =
    firstFuture && lastFuture
      ? firstFuture === lastFuture
        ? formatMonthShort(firstFuture.from, locale)
        : `${formatMonthShort(firstFuture.from, locale)}–${formatMonthShort(lastFuture.from, locale)}`
      : null;

  const points: TrendChartPoint[] = slots.map((s) => ({
    key: s.monthKey,
    axisLabel: formatMonthShort(s.from, locale),
    label: formatMonthYear(s.from, locale),
    state: s.state,
    billed: s.billedSatang === null ? null : toBaht(s.billedSatang),
    collected: s.collectedSatang === null ? null : toBaht(s.collectedSatang),
    billedLabel: s.billedSatang === null ? t('trend.notYet') : formatAmount(s.billedSatang),
    collectedLabel: s.collectedSatang === null ? t('trend.notYet') : formatAmount(s.collectedSatang),
  }));

  return (
    <Card
      title={title}
      description={description}
      headingLevel={2}
      footer={<p className="m-0 text-xs text-[var(--aura-fg-secondary)]">{t('trend.vatNote')}</p>}
    >
      <dl className="m-0 mb-[var(--aura-space-4)] flex flex-wrap gap-x-8 gap-y-2">
        <div>
          <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('trend.totalBilled', { range })}</dt>
          <dd className="m-0 text-lg font-semibold tabular-nums" data-testid="trend-total-billed">
            {formatAmount(billedTotal)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('trend.totalCollected', { range })}</dt>
          <dd className="m-0 text-lg font-semibold tabular-nums" data-testid="trend-total-collected">
            {formatAmount(collectedTotal)}
          </dd>
        </div>
      </dl>
      <TrendChart
        points={points}
        locale={locale}
        billedName={t('trend.legendBilled')}
        collectedName={t('trend.legendCollected')}
      />
      <ul aria-hidden="true" className="m-0 mt-[var(--aura-space-3)] flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-[var(--aura-fg-secondary)]">
        <li className="flex items-center gap-1.5">
          <Swatch color={BILLED_SERIES} />
          {t('trend.legendBilled')}
        </li>
        <li className="flex items-center gap-1.5">
          <Swatch color={COLLECTED_SERIES} />
          {t('trend.legendCollected')}
        </li>
        {current ? (
          <li className="flex items-center gap-1.5">
            <Swatch color={BILLED_SERIES} light />
            {t('trend.legendPartial', { month: formatMonthLong(current.from, locale) })}
          </li>
        ) : null}
        {futureLabel ? <li>{t('trend.legendFuture', { months: futureLabel })}</li> : null}
      </ul>
      <ChartDataTable
        caption={t('trend.tableCaption')}
        columns={[t('trend.month'), t('trend.legendBilled'), t('trend.legendCollected')]}
        rows={points.map((p) => [p.label, p.billedLabel, p.collectedLabel])}
      />
    </Card>
  );
}
