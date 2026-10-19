/**
 * T125a — SLA stats banner.
 *
 * FR-013 N2 remediation. Displays target SLA + median + p95 + severity
 * pill (green/amber/red).
 *
 * Severity rules (per spec § 2.7):
 *   - green: median ≤24h AND p95 ≤40h
 *   - amber: median >24h OR p95 >40h (and p95 ≤48h)
 *   - red:   p95 >48h (SC-002 breach)
 */
import { getTranslations } from 'next-intl/server';
import { Alert, Badge } from '@jirawatpyk/aura-react/server';

export interface SlaStats {
  readonly targetSlaHours: number;
  readonly medianTimeToDecisionHours: number | null;
  readonly p95TimeToDecisionHours: number | null;
  readonly decisionCount: number;
  readonly bannerSeverity: 'green' | 'amber' | 'red';
}

/** Spec 122 US12b — the severity as the AURA Alert / Badge tone. */
const SEVERITY_TONE = {
  green: 'success',
  amber: 'warning',
  red: 'danger',
} as const satisfies Record<SlaStats['bannerSeverity'], 'success' | 'warning' | 'danger'>;

export interface SlaBannerProps {
  readonly stats: SlaStats;
  /**
   * Renders a single muted inline stat line instead of the full coloured
   * banner. Used when an overdue banner is already showing elsewhere on
   * the page, so this component doesn't duplicate the visual alarm.
   * Defaults to `false` (existing full-banner behaviour, unchanged).
   */
  readonly compact?: boolean;
}

export async function SlaBanner({
  stats,
  compact = false,
}: SlaBannerProps): Promise<React.ReactElement | null> {
  const t = await getTranslations('admin.broadcasts.queue.slaBanner');
  const fmt = (n: number | null): string =>
    n === null ? '—' : n.toFixed(1);
  if (compact) {
    // M3 (2026-08-01-broadcast-review-queue-pr2 Task 8) — with zero
    // decisions the median/p95 fields are both `null`, so `fmt` renders
    // '—' for each and the line reads "Half decided within —h · 95%
    // within —h" — noise for an all-`submitted` tenant that hasn't
    // decided anything yet. Suppress the stat line entirely in that case.
    if (stats.decisionCount === 0) {
      return null;
    }
    return (
      <p className="aura-text-caption text-[var(--aura-fg-secondary)] tabular-nums">
        {t('medianRolling30d', { hours: fmt(stats.medianTimeToDecisionHours) })}{' '}
        <span aria-hidden="true">·</span>{' '}
        {t('p95Rolling30d', { hours: fmt(stats.p95TimeToDecisionHours) })}
      </p>
    );
  }
  const tone = SEVERITY_TONE[stats.bannerSeverity];
  const body = (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
      <span>{t('medianRolling30d', { hours: fmt(stats.medianTimeToDecisionHours) })}</span>
      <span aria-hidden="true">·</span>
      <span>{t('p95Rolling30d', { hours: fmt(stats.p95TimeToDecisionHours) })}</span>
      {/* D-banner-1 — no inner live region: when red the Alert itself is
          `role="alert"`; green / amber is server-derived per page load and
          never updates client-side. */}
      <Badge tone={tone} variant="solid">
        {stats.bannerSeverity === 'red' ? t('breachWarning') : t('withinBudget')}
      </Badge>
    </span>
  );
  // Spec 122 US12b — an AURA Alert in the severity's tone. A breach is
  // announced (`role="alert"`); otherwise it is a named region.
  if (stats.bannerSeverity === 'red') {
    return (
      <Alert tone={tone} role="alert" icon="clock" aria-label={t('targetSla')} title={t('targetSla')}>
        {body}
      </Alert>
    );
  }
  return (
    <section aria-label={t('targetSla')}>
      <Alert tone={tone} role="none" icon="clock" title={t('targetSla')}>
        {body}
      </Alert>
    </section>
  );
}
