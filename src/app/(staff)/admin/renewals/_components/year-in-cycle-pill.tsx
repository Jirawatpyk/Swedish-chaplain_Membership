/**
 * F8 Phase 8 T220 — `<YearInCyclePill>` shared component (per FR-043).
 *
 * Multi-year contract UX primitive: displays which year of a multi-year
 * cycle a manual touchpoint belongs to + the touchpoint label + member
 * company name in a single compact pill (e.g. `Year 2 of 3 · Quarterly
 * review · Fogmaker AB`).
 *
 * Per FR-010 + Q4 round 1: email reminders only fire in the FINAL year
 * of multi-year contracts, but escalation tasks (manual touchpoints)
 * fire EVERY year. The pill is the visual signal admins use to confirm
 * they're acting on the right cycle year.
 *
 * Phase 8 owns the primitive; Phase 9+ surfaces (member detail timeline,
 * cycle detail page) wire it in.
 *
 * Variant `'compact'` is used inside the queue table cell; `'full'`
 * surfaces it as a standalone badge with the company name visible.
 *
 * R10 W10 close — `'use client'` directive added explicitly because
 * `useTranslations` is a client-only hook. Today the component
 * inherits its parent's client boundary, but a future Phase 9 server
 * component (e.g. member detail timeline) that imports this file
 * would throw "context not found" without an explicit boundary.
 */
'use client';

import { useTranslations } from 'next-intl';

export interface YearInCyclePillProps {
  readonly yearInCycle: number;
  readonly totalYears: number;
  readonly taskTypeLabel: string;
  readonly memberCompanyName?: string | undefined;
  readonly variant?: 'compact' | 'full' | undefined;
}

/**
 * Pure presentation — relies on `next-intl` for the `'Year {y} of {t}'`
 * ICU plural copy under `admin.renewals.tasks.yearInCycle.*`. Caller
 * supplies the localised `taskTypeLabel` (the queue resolves it via
 * `t('taskType.<task_type>')`).
 */
export function YearInCyclePill({
  yearInCycle,
  totalYears,
  taskTypeLabel,
  memberCompanyName,
  variant = 'compact',
}: YearInCyclePillProps) {
  const t = useTranslations('admin.renewals.tasks.yearInCycle');

  // Single-year contracts (totalYears === 1) — drop the "Year 1 of 1"
  // prefix as it adds noise. The pill collapses to "<taskType> · <co>".
  const showYearPrefix = totalYears > 1;

  const label = showYearPrefix
    ? t('pill', { year: yearInCycle, total: totalYears })
    : null;

  if (variant === 'full' && memberCompanyName !== undefined) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground"
        aria-label={t('aria_label', {
          year: yearInCycle,
          total: totalYears,
          taskType: taskTypeLabel,
          company: memberCompanyName,
        })}
      >
        {label !== null && (
          <>
            <span>{label}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span>{taskTypeLabel}</span>
        <span aria-hidden>·</span>
        <span className="font-normal text-muted-foreground">
          {memberCompanyName}
        </span>
      </span>
    );
  }

  // compact variant — used inside table cells with company name in a
  // separate column. Drops the company name to save horizontal space.
  // Round 5 I-22 close — added `aria-label` so screen-reader users get
  // the same year-context information that sighted users see in the
  // visible "Year X of Y" pill (parity with `full` variant).
  // R6 UX-I-3 close — fallback case (multi-year, no company) now uses
  // a dedicated i18n key `aria_label_no_company` so translators
  // control the separator (raw "·" U+00B7 was inconsistent across SR).
  const compactAriaLabel =
    showYearPrefix && memberCompanyName !== undefined
      ? t('aria_label', {
          year: yearInCycle,
          total: totalYears,
          taskType: taskTypeLabel,
          company: memberCompanyName,
        })
      : showYearPrefix
        ? t('aria_label_no_company', {
            year: yearInCycle,
            total: totalYears,
            taskType: taskTypeLabel,
          })
        : taskTypeLabel;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs"
      aria-label={compactAriaLabel}
    >
      {label !== null && (
        <span aria-hidden className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
          {label}
        </span>
      )}
      <span aria-hidden className="text-foreground">{taskTypeLabel}</span>
    </span>
  );
}
