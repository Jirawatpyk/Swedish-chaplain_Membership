/**
 * F8 Phase 3 Wave H4 · T074 — `UrgencyPill` shared component.
 *
 * Renders one of the 8 derived urgency buckets with semantic colour +
 * screen-reader-friendly text. Pure presentational — the bucket itself
 * is computed DB-side per FR-046 and passed in.
 *
 * Bucket→colour gradient: slate (low urgency) → amber → orange → red
 * (urgent countdown) → deep amber (suspended — benefits paused, still
 * recoverable) → gray (terminated — membership ended).
 */
import { useTranslations } from 'next-intl';
import { Badge, type BadgeProps } from '@jirawatpyk/aura-react/server';
import { cn } from '@/lib/utils';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for rationale.
import type { UrgencyBucket } from '@/modules/renewals/client';

/**
 * 122 US7a — AURA badge tones, one step louder as the deadline nears: the
 * far countdown is neutral, 30 and 14 days are warning, 7 days and today
 * are danger. Past the deadline, suspended is the one SOLID chip (paused,
 * recoverable: the loudest of the group, amber like the members directory's
 * Suspended badge) and terminated is a quiet outline (membership ended).
 * The label always names the stage, so colour is never the only signal.
 */
const URGENCY_BADGE: Record<UrgencyBucket, Pick<BadgeProps, 'tone' | 'variant'>> = {
  't-90': { tone: 'neutral' },
  't-60': { tone: 'neutral' },
  't-30': { tone: 'warning' },
  't-14': { tone: 'warning' },
  't-7': { tone: 'danger' },
  't-0': { tone: 'danger' },
  suspended: { tone: 'warning', variant: 'solid' },
  terminated: { tone: 'neutral', variant: 'outline' },
};

export interface UrgencyPillProps {
  readonly urgency: UrgencyBucket;
  readonly className?: string;
}

export function UrgencyPill({ urgency, className }: UrgencyPillProps) {
  const t = useTranslations('admin.renewals.urgencyPill');
  // i18n keys use friendly identifiers (no hyphens in JSON keys would
  // trip JSON parsers in some IDE plugins); we map dashes to friendly
  // tokens at the boundary.
  const i18nKey = urgency.replace('-', '_');
  const label = t(
    i18nKey as
      | 't_90'
      | 't_60'
      | 't_30'
      | 't_14'
      | 't_7'
      | 't_0'
      | 'suspended'
      | 'terminated',
  );
  // K12-2 (UX-K-6): no aria-label — the visible text serves as the
  // accessible name for this non-interactive `<span>`. Setting both
  // causes older VoiceOver versions to double-announce; WCAG 1.1 +
  // 4.1.2 prefer the visible text alone when it is sufficient.
  // Sibling pattern: TierBadge (K9) + LapsedTab reason badge (K9).
  return (
    <Badge {...URGENCY_BADGE[urgency]} className={cn('whitespace-nowrap', className)}>
      {label}
    </Badge>
  );
}
