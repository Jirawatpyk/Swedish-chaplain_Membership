/**
 * F8 Phase 6 Wave E · T168 — `RiskScoreBadge` shared component.
 *
 * Renders a 0-100 risk score + 4-band classification (healthy /
 * warning / at-risk / critical per FR-030 proportional bands) with
 * semantic colour + screen-reader text. Pure presentational — the
 * band is computed by the Application + Domain (FR-029a F6-readiness
 * fallback) and passed in.
 *
 * No-colour-only signalling per FR-050: the band name is rendered as
 * text inside the badge AND the screen-reader narration explicitly
 * names the band so assistive tech users get the same information as
 * sighted users (WCAG 1.4.1).
 */
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

// Single source of truth — the F8 at-risk band lives in the insights domain
// (re-exported here for existing consumers). Type-only, so this client
// component pulls no server graph from the @/modules/insights barrel.
import type { RiskBand } from '@/modules/insights';
export type { RiskBand };

const VARIANT_CLASSES: Record<RiskBand, string> = {
  healthy:
    'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900',
  warning:
    'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900',
  'at-risk':
    'bg-orange-100 text-orange-900 ring-orange-300 dark:bg-orange-950 dark:text-orange-200 dark:ring-orange-800',
  critical:
    'bg-red-100 text-red-900 ring-red-300 dark:bg-red-950 dark:text-red-200 dark:ring-red-800',
};

export interface RiskScoreBadgeProps {
  readonly score: number;
  readonly band: RiskBand;
  readonly activeMax: 70 | 100;
  readonly className?: string;
}

export function RiskScoreBadge({
  score,
  band,
  activeMax,
  className,
}: RiskScoreBadgeProps) {
  const t = useTranslations('admin.renewals.atRisk.scoreBadge');
  // i18n keys map dashes to friendly tokens.
  const i18nKey = band.replace('-', '_') as
    | 'healthy'
    | 'warning'
    | 'at_risk'
    | 'critical';
  const bandLabel = t(`band.${i18nKey}`);
  const srText = t('srLabel', { score, max: activeMax, band: bandLabel });
  return (
    <span
      // T097 (F9 a11y) — role="img" makes aria-label valid on this badge
      // (ARIA prohibits aria-label on a roleless span; axe
      // `aria-prohibited-attr` / WCAG 4.1.2). The inner spans are aria-hidden,
      // so the badge reads as a single labelled element ("Risk score N of M,
      // band X") to screen readers — preserving the exact SR experience.
      role="img"
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap',
        VARIANT_CLASSES[band],
        className,
      )}
      aria-label={srText}
    >
      <span className="font-semibold tabular-nums" aria-hidden="true">
        {score}
      </span>
      <span aria-hidden="true">·</span>
      <span aria-hidden="true">{bandLabel}</span>
    </span>
  );
}
