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
import { Badge, type BadgeProps } from '@jirawatpyk/aura-react/server';
import { cn } from '@/lib/utils';

// Single source of truth — the F8 at-risk band lives in the insights domain
// (re-exported here for existing consumers). Type-only, so this client
// component pulls no server graph from the @/modules/insights barrel.
import type { RiskBand } from '@/modules/insights';
export type { RiskBand };

/** 122 US7a — AURA badge tones by band; critical is the one solid chip. */
const BAND_BADGE: Record<RiskBand, Pick<BadgeProps, 'tone' | 'variant'>> = {
  healthy: { tone: 'success' },
  warning: { tone: 'warning' },
  'at-risk': { tone: 'danger' },
  critical: { tone: 'danger', variant: 'solid' },
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
    <Badge
      {...BAND_BADGE[band]}
      // T097 (F9 a11y) — role="img" makes aria-label valid on this badge
      // (ARIA prohibits aria-label on a roleless span; axe
      // `aria-prohibited-attr` / WCAG 4.1.2). The inner spans are aria-hidden,
      // so the badge reads as a single labelled element ("Risk score N of M,
      // band X") to screen readers — preserving the exact SR experience.
      role="img"
      className={cn('whitespace-nowrap', className)}
      aria-label={srText}
    >
      <span className="font-semibold tabular-nums" aria-hidden="true">
        {score}
      </span>
      <span aria-hidden="true">·</span>
      <span aria-hidden="true">{bandLabel}</span>
    </Badge>
  );
}
