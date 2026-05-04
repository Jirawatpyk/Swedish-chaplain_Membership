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
import { cn } from '@/lib/utils';
import type { TierBucket } from '@/modules/renewals';

const VARIANT_CLASSES: Record<TierBucket, string> = {
  thai_alumni:
    'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900',
  start_up:
    'bg-blue-50 text-blue-900 ring-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-900',
  regular:
    'bg-slate-50 text-slate-900 ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700',
  premium:
    'bg-purple-50 text-purple-900 ring-purple-200 dark:bg-purple-950 dark:text-purple-200 dark:ring-purple-900',
  partnership:
    'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900',
};

export interface TierBadgeProps {
  readonly tier: TierBucket;
  readonly className?: string;
}

export function TierBadge({ tier, className }: TierBadgeProps) {
  const t = useTranslations('admin.renewals.tierBadge');
  const label = t(tier);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        VARIANT_CLASSES[tier],
        className,
      )}
      aria-label={label}
    >
      {label}
    </span>
  );
}
