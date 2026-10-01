/**
 * F8 Phase 3 Wave H4 · T073 — `TierBadge` shared component.
 *
 * Reusable across F8 admin + member portal surfaces. Renders a member's
 * 5-bucket tier with a colour-coded pill + accessible label.
 *
 * Tier→colour mapping (data-model.md § 2.1 frozen_tier_bucket enum):
 *   - thai_alumni → gold
 *   - start_up    → blue
 *   - regular     → slate
 *   - premium     → purple
 *   - partnership → emerald
 *
 * The label text comes from i18n (`admin.renewals.tierBadge.{bucket}`)
 * so the same component renders in EN/TH/SV without prop drilling.
 */
import { useTranslations } from 'next-intl';
import { Badge, type BadgeProps } from '@jirawatpyk/aura-react/server';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for rationale.
import type { TierBucket } from '@/modules/renewals/client';

/**
 * 122 US7a (maintainer decision, 1 Oct 2026) — a tier is a category, not a
 * state, so it never takes a status tone: warning, success and danger stay
 * for the urgency pill and the risk badge beside it in the same row.
 * Partnership is `accent`, as on the plans list (`plans-table.tsx`); every
 * other tier is `neutral`. The label names the tier.
 */
const TIER_TONE: Record<TierBucket, BadgeProps['tone']> = {
  partnership: 'accent',
  premium: 'neutral',
  regular: 'neutral',
  start_up: 'neutral',
  thai_alumni: 'neutral',
};

export interface TierBadgeProps {
  readonly tier: TierBucket;
  readonly className?: string;
}

export function TierBadge({ tier, className }: TierBadgeProps) {
  const t = useTranslations('admin.renewals.tierBadge');
  const label = t(tier);
  // K9: removed `aria-label={label}` — when aria-label is identical to
  // the visible text content of a non-interactive element, some screen
  // readers (older VoiceOver) double-announce. Removing the redundant
  // label lets the text content serve as the accessible name (WCAG
  // recommends NOT setting aria-label when visible text is sufficient).
  return (
    <Badge tone={TIER_TONE[tier]} {...(className ? { className } : {})}>
      {label}
    </Badge>
  );
}
