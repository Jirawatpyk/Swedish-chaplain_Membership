/**
 * F8 cycle-status badge — Wave K27 / I-1.
 *
 * Renders a coloured pill for each `CycleStatus` discriminator,
 * mirroring the tonal palette used by `lapsed-tab.tsx`'s
 * `REASON_VARIANT_CLASSES` so admins navigating between the pipeline
 * (urgency-bucket badges + lapsed reason badges) and this detail
 * view see consistent treatments. Dark-mode variants included.
 *
 * Pure presentational — no client interactivity needed; ships as a
 * server component.
 */
import type { CycleStatus } from '@/modules/renewals';
import { cn } from '@/lib/utils';

// Tonal contrast bumped — `upcoming`/`reminded` previously
// blended into card surfaces (slate-50/blue-50 on white-ish bg).
// Using -100 base + -300 ring for visible distinction; severity
// statuses (`lapsed`, `pending_admin_reactivation`) keep stronger
// tones to dominate scan order.
const STATUS_VARIANT_CLASSES: Record<CycleStatus, string> = {
  upcoming:
    'bg-slate-100 text-slate-900 ring-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600',
  reminded:
    'bg-sky-100 text-sky-900 ring-sky-300 dark:bg-sky-900 dark:text-sky-100 dark:ring-sky-600',
  awaiting_payment:
    'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-900 dark:text-amber-100 dark:ring-amber-600',
  completed:
    'bg-emerald-100 text-emerald-900 ring-emerald-300 dark:bg-emerald-900 dark:text-emerald-100 dark:ring-emerald-600',
  lapsed:
    'bg-red-100 text-red-900 ring-red-300 dark:bg-red-900 dark:text-red-100 dark:ring-red-600',
  cancelled:
    'bg-gray-200 text-gray-800 ring-gray-400 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-600',
  pending_admin_reactivation:
    'bg-orange-100 text-orange-900 ring-orange-300 dark:bg-orange-900 dark:text-orange-100 dark:ring-orange-600',
};

export interface CycleStatusBadgeProps {
  readonly status: CycleStatus;
  readonly label: string;
  /**
   * Phase 6 review-round 2 C1 — translated screen-reader severity
   * suffix for severity-bearing statuses (`lapsed`,
   * `pending_admin_reactivation`). Caller resolves the locale via
   * `useTranslations`; the badge stays presentational + SSR-safe.
   * `null`/`undefined` → no suffix rendered (informational statuses).
   */
  readonly srSuffix?: string | null;
}

export function CycleStatusBadge({
  status,
  label,
  srSuffix,
}: CycleStatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_VARIANT_CLASSES[status],
      )}
    >
      {label}
      {srSuffix ? <span className="sr-only">{srSuffix}</span> : null}
    </span>
  );
}
