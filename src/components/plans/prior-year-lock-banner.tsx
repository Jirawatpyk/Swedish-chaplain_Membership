/**
 * T119 — PriorYearLockBanner (US3 FR-014).
 *
 * Persistent banner rendered at the top of the edit form when the
 * plan's `plan_year < currentYear`. Explains the partial-lock rule
 * and offers a one-click "Clone to current year and edit there"
 * action that navigates to the clone page pre-filled with the right
 * source/target years.
 *
 * i18n keys live under `admin.plans.lockBanner`.
 */
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  InlineAlert,
  InlineAlertDescription,
  InlineAlertTitle,
} from '@/components/ui/inline-alert';

export interface PriorYearLockBannerProps {
  readonly planYear: number;
  readonly currentYear: number;
}

export function PriorYearLockBanner({
  planYear,
  currentYear,
}: PriorYearLockBannerProps) {
  const t = useTranslations('admin.plans.priorYearLock');

  return (
    <InlineAlert tone="warning">
      <InlineAlertTitle>{t('banner', { year: planYear })}</InlineAlertTitle>
      <InlineAlertDescription className="mt-2 space-y-2">
        <p>{t('explanation')}</p>
        <Link
          href={`/admin/plans/clone?from=${planYear}&to=${currentYear}`}
          className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground"
        >
          {t('cloneCta', { currentYear })}
        </Link>
      </InlineAlertDescription>
    </InlineAlert>
  );
}
