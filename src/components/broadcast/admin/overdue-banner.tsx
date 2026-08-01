/**
 * Task 3 (2026-08-01-broadcast-review-queue-pr1) — overdue-now banner.
 *
 * The 30-day `SlaBanner` trend is structurally blind to a CURRENT
 * backlog (a queue that has been perfectly healthy for 29 days can
 * still be sitting on a multi-day pile-up today). This banner
 * surfaces the CURRENT count of `submitted` broadcasts waiting more
 * than 48 hours, computed by the page and passed in as `count`.
 *
 * Mirrors the shipped erasure-log breach banner
 * (`src/app/(staff)/admin/compliance/erasure-log/page.tsx:179-184`):
 * a destructive `role="alert"` div, rendered only when there is
 * something to report. Sync Server Component (`useTranslations`, not
 * `getTranslations` — no async boundary needed), so it composes
 * directly in the page JSX without an `await`.
 */
import { useTranslations } from 'next-intl';

export interface OverdueBannerProps {
  readonly count: number;
}

export function OverdueBanner({ count }: OverdueBannerProps): React.ReactElement | null {
  const t = useTranslations('admin.broadcasts.queue');
  if (count <= 0) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive-surface p-3 text-sm font-medium text-destructive"
    >
      {t('overdueBanner', { count })}
    </div>
  );
}
