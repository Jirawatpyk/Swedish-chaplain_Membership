/**
 * F9 (T033) — KPI card. Pure presentational server component: a labelled metric
 * tile for the operations dashboard. The caller passes a display-ready,
 * locale-formatted `value` (currency/number formatting stays in the page).
 *
 * `value` widened from `string` to `ReactNode` (Task 15,
 * 067-dashboard-interactive-charts) so a caller can pass
 * `<CountUp value={n} locale={locale} variant="integer" />` for the
 * rolling-number animation without this component needing to know anything
 * about it — plain string callers keep working unchanged.
 *
 * Fix round 2 (renewals money-band review) — `href`/`ariaLabel` added so the
 * renewals pipeline's THB money band (`pipeline-money-band.tsx`) can reuse
 * this component instead of a bespoke tile (Reusable-Components principle).
 * Purely additive: both props are optional and every existing F9 dashboard
 * call site (`admin/(home)/page.tsx`) omits them, rendering byte-identical to
 * before.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function KpiCard({
  label,
  value,
  caption,
  href,
  ariaLabel,
}: {
  readonly label: string;
  readonly value: ReactNode;
  /**
   * Optional one-line basis note under the value (e.g. the revenue tile's
   * "Fiscal year to date · ex-VAT"). Every money/count figure on the dashboard
   * is computed on a different basis; stating each tile's basis here keeps the
   * label short while a viewer can still tell why two tiles don't tie out.
   */
  readonly caption?: string;
  /**
   * Optional deep-link. When present, the whole card header becomes a
   * `next/link` `Link` (full-tile click target) instead of a static block.
   */
  readonly href?: string;
  /**
   * Short accessible name for the link (e.g. "Past due — view overdue
   * renewals") so screen-reader link/Tab navigation announces a concise
   * purpose instead of the full concatenated label+value+caption sentence.
   * Ignored when `href` is absent.
   */
  readonly ariaLabel?: string;
}) {
  const header = (
    <CardHeader className="pb-2">
      <CardDescription>{label}</CardDescription>
      <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      {caption ? <p className="mt-1 text-caption text-muted-foreground">{caption}</p> : null}
    </CardHeader>
  );

  if (href) {
    return (
      <Card>
        <Link
          href={href}
          aria-label={ariaLabel}
          className="block rounded-[var(--card-radius)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {header}
        </Link>
      </Card>
    );
  }
  return <Card>{header}</Card>;
}
