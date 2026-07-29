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
 *
 * renewals-money-band-compact4 — `compact`/`tone` added for the same reason:
 * the money band went from 4 hero tiles → a 2-KPI strip → back to all 4 KPIs,
 * this time as a shorter COMPACT tile instead of the original hero card.
 * Both new props default to the pre-existing look (`compact = false`,
 * `tone = 'default'`), so every other call site (F9 dashboard) renders
 * byte-identical to before.
 *
 * renewals-overdue-prior-fy-subline — `subline`/`labelHint` added (same
 * additive pattern, both optional, absent = byte-identical render) so the
 * money band can (a) append a muted secondary line under the Past-due tile
 * and (b) attach an info-hint affordance next to the Collection-rate
 * label. See each prop's doc for the placement constraints. UX-review
 * follow-up F2 hardened the `labelHint`×`href` prose warning into a
 * DISCRIMINATED UNION — passing both is now a compile-time error (nested
 * interactive control + the link's `aria-label` would swallow the hint).
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface KpiCardBaseProps {
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
   * Shrinks the tile: `Card size="sm"` (tighter `py-3`/`px-3`, the existing
   * shadcn/ui compact-card variant) + a `text-2xl` value instead of the
   * `text-3xl` hero. For bands that need every KPI to fit one balanced row
   * without reading as oversized (renewals money band). Defaults to `false`
   * (current hero look, unchanged for every existing caller).
   */
  readonly compact?: boolean;
  /**
   * Colours the VALUE only (never the label or the card chrome) via the
   * app's semantic tokens. `'success'` → `text-success`, `'warning'` →
   * `text-warning`; both measured ≥5:1 against `bg-card` in light AND dark
   * theme (comfortably clears WCAG AA's 4.5:1 floor for normal text) — the
   * same token pair `StatCard` and the invoice payment timeline already use
   * for status text on a card background. Defaults to `'default'` (no
   * colour override, current behaviour).
   */
  readonly tone?: 'default' | 'success' | 'warning';
  /**
   * Optional muted secondary line rendered BELOW the header — and, on a
   * linked tile, OUTSIDE the `Link` subtree. Load-bearing for a11y: the
   * link's `aria-label` REPLACES its descendant text in the accessible-name
   * computation, so a note nested inside the link would be unreachable for
   * screen-reader users; as a sibling it stays in normal document flow.
   * (Renewals money band: the "+ overdue from prior years" note.)
   */
  readonly subline?: ReactNode;
}

/**
 * UX-review follow-up F2 — `href` and `labelHint` are MUTUALLY EXCLUSIVE at
 * the type level. A linked tile wraps its whole header in a `next/link` with
 * an `aria-label`, so an interactive hint inside it would be (a) a nested
 * interactive control and (b) invisible to screen readers (the label
 * replaces descendant text). `?: never` (not `?: undefined`) so under
 * `exactOptionalPropertyTypes` the disallowed prop can only be OMITTED —
 * every pre-existing call site (F9 dashboard: neither; band: one or the
 * other) still typechecks unchanged, and runtime behaviour is identical.
 */
type KpiCardProps = KpiCardBaseProps &
  (
    | {
        /**
         * Deep-link: the whole card header becomes a `next/link` `Link`
         * (full-tile click target) instead of a static block.
         */
        readonly href: string;
        /**
         * Short accessible name for the link (e.g. "Past due — view overdue
         * renewals") so screen-reader link/Tab navigation announces a concise
         * purpose instead of the full concatenated label+value+caption
         * sentence.
         */
        readonly ariaLabel?: string;
        readonly labelHint?: never;
      }
    | {
        readonly href?: never;
        readonly ariaLabel?: never;
        /**
         * Optional inline affordance appended after the label (e.g. an
         * `InfoHint` popover trigger). Non-linked tiles only — enforced by
         * this union branch.
         */
        readonly labelHint?: ReactNode;
      }
  );

export function KpiCard({
  label,
  value,
  caption,
  href,
  ariaLabel,
  compact = false,
  tone = 'default',
  subline,
  labelHint,
}: KpiCardProps) {
  const toneClass =
    tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : undefined;

  const header = (
    <CardHeader className="pb-2">
      <CardDescription>
        {labelHint ? (
          <span className="flex items-center gap-1">
            {label}
            {labelHint}
          </span>
        ) : (
          label
        )}
      </CardDescription>
      <CardTitle className={cn(compact ? 'text-2xl' : 'text-3xl', 'tabular-nums', toneClass)}>
        {value}
      </CardTitle>
      {caption ? <p className="mt-1 text-caption text-muted-foreground">{caption}</p> : null}
    </CardHeader>
  );

  // Pulls the note up against the caption: the Card's own flex gap (gap-4,
  // sm: gap-3) minus -mt-2 nets ~8px hero / ~4px compact — reads as part of
  // the tile, not a detached footer row.
  const sublineBlock = subline ? (
    <CardContent className="-mt-2 text-caption text-muted-foreground">{subline}</CardContent>
  ) : null;

  if (href) {
    return (
      <Card size={compact ? 'sm' : 'default'}>
        <Link
          href={href}
          aria-label={ariaLabel}
          className="block rounded-[var(--card-radius)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {header}
        </Link>
        {sublineBlock}
      </Card>
    );
  }
  return (
    <Card size={compact ? 'sm' : 'default'}>
      {header}
      {sublineBlock}
    </Card>
  );
}
