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
import { Clock } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils';

export interface SlaStats {
  readonly targetSlaHours: number;
  readonly medianTimeToDecisionHours: number | null;
  readonly p95TimeToDecisionHours: number | null;
  readonly decisionCount: number;
  readonly bannerSeverity: 'green' | 'amber' | 'red';
}

const SEVERITY_STYLES: Record<SlaStats['bannerSeverity'], string> = {
  green: 'border-success/40 bg-success-surface text-success',
  amber: 'border-warning/40 bg-warning-surface text-warning',
  red: 'border-destructive/40 bg-destructive-surface text-destructive',
};

const PILL_STYLES: Record<SlaStats['bannerSeverity'], string> = {
  green: 'bg-success/15',
  amber: 'bg-warning/15',
  red: 'bg-destructive/15',
};

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
}: SlaBannerProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.queue.slaBanner');
  const fmt = (n: number | null): string =>
    n === null ? '—' : n.toFixed(1);
  if (compact) {
    return (
      <p className="text-xs text-muted-foreground tabular-nums">
        {t('medianRolling30d', { hours: fmt(stats.medianTimeToDecisionHours) })} ·{' '}
        {t('p95Rolling30d', { hours: fmt(stats.p95TimeToDecisionHours) })}
      </p>
    );
  }
  return (
    <div
      role={stats.bannerSeverity === 'red' ? 'alert' : 'region'}
      aria-label={t('targetSla')}
      className={cn(
        'flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border px-4 py-3 text-sm',
        SEVERITY_STYLES[stats.bannerSeverity],
      )}
    >
      <div className="flex items-center gap-2 font-medium">
        <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t('targetSla')}</span>
      </div>
      <div className="flex items-center gap-x-4 gap-y-1 tabular-nums">
        <span>
          {t('medianRolling30d', { hours: fmt(stats.medianTimeToDecisionHours) })}
        </span>
        <span aria-hidden="true">·</span>
        <span>{t('p95Rolling30d', { hours: fmt(stats.p95TimeToDecisionHours) })}</span>
      </div>
      {/* D-banner-1 UX hardening — removed `aria-live="polite"` on
          this inner pill. When severity=red the outer wrapper already
          has `role="alert"` and auto-announces the entire region; an
          inner polite region would either duplicate the announcement
          or fight the alert priority. For green/amber the value is
          server-derived per page-load (cached 5 min via
          `unstable_cache`) and never updates client-side, so a live
          region would never fire — pure noise to assistive tech. */}
      <span
        className={cn(
          'ml-auto rounded-full px-2 py-0.5 text-xs font-semibold',
          PILL_STYLES[stats.bannerSeverity],
        )}
      >
        {stats.bannerSeverity === 'red' ? t('breachWarning') : t('withinBudget')}
      </span>
    </div>
  );
}
