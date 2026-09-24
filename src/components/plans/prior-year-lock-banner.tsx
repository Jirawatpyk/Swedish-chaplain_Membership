/**
 * T119 — PriorYearLockBanner (US3 FR-014).
 *
 * Persistent banner rendered at the top of the edit form when the
 * plan's `plan_year < currentYear`. Explains the partial-lock rule
 * and offers one CTA:
 *   - the same plan ID exists in the current year → "Open the {year}
 *     version", which goes to that plan's edit page;
 *   - otherwise → the clone page prefilled with `from` / `to`. The clone
 *     page copies a WHOLE year and refuses a target year that already has
 *     plans, so it is only the right destination when the current year
 *     has no version of this plan.
 *
 * i18n keys live under `admin.plans.priorYearLock`.
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
  readonly planId: string;
  readonly planYear: number;
  readonly currentYear: number;
  /** A non-deleted plan with the same `planId` exists in `currentYear`. */
  readonly currentYearPlanExists: boolean;
}

export function PriorYearLockBanner({
  planId,
  planYear,
  currentYear,
  currentYearPlanExists,
}: PriorYearLockBannerProps) {
  const t = useTranslations('admin.plans.priorYearLock');

  const href = currentYearPlanExists
    ? `/admin/plans/${currentYear}/${planId}/edit`
    : `/admin/plans/clone?from=${planYear}&to=${currentYear}`;

  return (
    <InlineAlert tone="warning">
      <InlineAlertTitle>{t('banner', { year: planYear })}</InlineAlertTitle>
      <InlineAlertDescription className="mt-2 space-y-2">
        <p>
          {currentYearPlanExists
            ? t('explanation', { currentYear })
            : t('explanationNoCurrentVersion', { year: planYear, currentYear })}
        </p>
        <Link
          href={href}
          className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground"
        >
          {currentYearPlanExists
            ? t('openCurrentCta', { currentYear })
            : t('cloneCta', { year: planYear, currentYear })}
        </Link>
      </InlineAlertDescription>
    </InlineAlert>
  );
}
