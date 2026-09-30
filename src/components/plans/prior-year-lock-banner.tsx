/**
 * T119 — PriorYearLockBanner (US3 FR-014).
 *
 * Persistent banner rendered at the top of the edit form when the
 * plan's `plan_year < currentYear`. Explains the partial-lock rule
 * and offers one CTA, picked by `currentYearStatus`:
 *   - `has_plan` (the same plan ID exists in the current year) → "Open the
 *     {year} version", which goes to that plan's edit page;
 *   - `empty` (the current year has no plans) → the clone page prefilled
 *     with `from` / `to`. The clone copies a WHOLE year and refuses a
 *     target year that already has plans, so this is the only state where
 *     it can succeed;
 *   - `other_plans` → the new-plan wizard, to add this plan to the year.
 *
 * i18n keys live under `admin.plans.priorYearLock`.
 *
 * 122 US6 (T606): AURA's warning Alert as the `Admin-plan-edit-locked`
 * board draws it — a standing note (not a live region: it is there when the
 * page opens), the action an AURA secondary button with its arrow.
 */
'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRightIcon } from 'lucide-react';
import { Alert, buttonClass } from '@jirawatpyk/aura-react';
import { formatCalendarYear } from '@/lib/format-date-localised';

/**
 * What the current year holds, relative to this plan:
 *   - `has_plan`: a non-deleted plan with the same plan ID;
 *   - `empty`: no non-deleted plans at all;
 *   - `other_plans`: plans, but not this one.
 */
export type CurrentYearPlanStatus = 'has_plan' | 'empty' | 'other_plans';

export interface PriorYearLockBannerProps {
  readonly planId: string;
  readonly planYear: number;
  readonly currentYear: number;
  readonly currentYearStatus: CurrentYearPlanStatus;
}

export function PriorYearLockBanner({
  planId,
  planYear,
  currentYear,
  currentYearStatus,
}: PriorYearLockBannerProps) {
  const t = useTranslations('admin.plans.priorYearLock');
  const locale = useLocale();
  // Visible years follow the locale (TH 2569); the hrefs below stay CE.
  const shownYear = formatCalendarYear(planYear, locale);
  const shownCurrentYear = formatCalendarYear(currentYear, locale);

  const cta = {
    has_plan: {
      href: `/admin/plans/${currentYear}/${planId}/edit`,
      explanation: t('explanation', { currentYear: shownCurrentYear }),
      label: t('openCurrentCta', { currentYear: shownCurrentYear }),
    },
    empty: {
      href: `/admin/plans/clone?from=${planYear}&to=${currentYear}`,
      explanation: t('explanationNoCurrentVersion', {
        year: shownYear,
        currentYear: shownCurrentYear,
      }),
      label: t('cloneCta', { year: shownYear, currentYear: shownCurrentYear }),
    },
    other_plans: {
      href: '/admin/plans/new',
      explanation: t('explanationCreateInCurrentYear', { currentYear: shownCurrentYear }),
      label: t('createCta', { currentYear: shownCurrentYear }),
    },
  }[currentYearStatus];

  return (
    <Alert
      tone="warning"
      role="note"
      title={t('banner', { year: shownYear })}
      action={
        <Link href={cta.href} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
          <ArrowRightIcon aria-hidden="true" className="size-4" />
          {cta.label}
        </Link>
      }
    >
      {cta.explanation}
    </Alert>
  );
}
