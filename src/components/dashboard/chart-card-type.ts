/**
 * Spec 122 US11 — the chart cards' headline number, set like AURA's `Stat`
 * value (`.aura-stat__value`: 28px floor, 1.2 line height, semibold), so the
 * figures above each chart read at the same scale as the KPI tiles above
 * them. A plain string with no recharts import, so the eager chart files can
 * use it without pulling the chart bundle into `/admin`'s first load.
 *
 * `min-w-0` + `overflow-wrap:anywhere`: Intl joins "THB" and the number with
 * a no-break space, so at 200% text the figure is one token wider than a
 * phone; it may break inside rather than widen the page (WCAG 1.4.10).
 */
export const CHART_HERO_VALUE =
  'min-w-0 [overflow-wrap:anywhere] text-[max(28px,1.75rem)] leading-[1.2] font-semibold tracking-[-0.01em] tabular-nums text-[var(--aura-fg-primary)]';

/** The headline row: the figure group, then its label; both wrap when tight. */
export const CHART_HERO_ROW = 'flex flex-wrap items-baseline justify-between gap-[var(--aura-space-2)]';
/** The figure plus its chip (delta / top tier). */
export const CHART_HERO_GROUP = 'flex min-w-0 flex-wrap items-baseline gap-[var(--aura-space-2)]';
