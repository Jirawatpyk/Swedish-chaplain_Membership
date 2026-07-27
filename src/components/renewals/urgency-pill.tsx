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
import { cn } from '@/lib/utils';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for rationale.
import type { UrgencyBucket } from '@/modules/renewals/client';

export const VARIANT_CLASSES: Record<UrgencyBucket, string> = {
  't-90':
    'bg-slate-50 text-slate-700 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700',
  't-60':
    'bg-slate-50 text-slate-700 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700',
  't-30':
    'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900',
  't-14':
    'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800',
  't-7':
    'bg-orange-100 text-orange-900 ring-orange-300 dark:bg-orange-950 dark:text-orange-200 dark:ring-orange-800',
  't-0':
    'bg-red-100 text-red-900 ring-red-300 dark:bg-red-950 dark:text-red-200 dark:ring-red-800',
  // suspended = a SOLID amber chip (amber-300 fill / amber-500 ring; dark
  // amber-800) — a deliberate tint→solid-fill "category jump" away from the pale
  // amber countdown tints (t-30 amber-50, t-14 amber-100) so it reads as the
  // loudest chip of the past-deadline group, while keeping amber's "paused,
  // recoverable" hue in step with the members-directory 'Suspended' badge (same
  // deriveMembershipAccess axis). Palette signed off by enterprise-ux — contrast
  // AA both themes (amber-950 on amber-300 ≈10.3:1; amber-100 on amber-800
  // ≈6.4:1). NB: Tailwind rings compile to box-shadows and cannot be dashed —
  // the distinction is by hue/shade, never a dashed ring.
  suspended:
    'bg-amber-300 text-amber-950 ring-amber-500 dark:bg-amber-800 dark:text-amber-100 dark:ring-amber-500',
  // terminated = muted gray: membership ended (kept from the old 'lapsed').
  terminated:
    'bg-gray-100 text-gray-700 ring-gray-300 dark:bg-gray-900 dark:text-gray-400 dark:ring-gray-700',
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
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap',
        VARIANT_CLASSES[urgency],
        className,
      )}
    >
      {label}
    </span>
  );
}
