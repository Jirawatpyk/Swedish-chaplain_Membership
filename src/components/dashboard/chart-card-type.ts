/**
 * Spec 122 US11 — the chart cards' headline number, set like AURA's `Stat`
 * value (`.aura-stat__value`: 28px floor, 1.2 line height, semibold), so the
 * figures above each chart read at the same scale as the KPI tiles above
 * them. A plain string with no recharts import, so the eager chart files can
 * use it without pulling the chart bundle into `/admin`'s first load.
 */
export const CHART_HERO_VALUE =
  'text-[max(28px,1.75rem)] leading-[1.2] font-semibold tracking-[-0.01em] tabular-nums text-[var(--aura-fg-primary)]';
