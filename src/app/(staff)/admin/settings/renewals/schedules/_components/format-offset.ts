import type { useTranslations } from 'next-intl';

/**
 * Shared offset-sentence formatter for the reminder-schedule editor.
 *
 * The compact "T±N" form (`formatOffset`) was removed in StepCard v3
 * cleanup — every user-facing surface now reads the plain-language
 * `timingSentence` instead (live QA: "T-30" reads as cryptic), and no
 * raw/Advanced code display remains that would want the compact form.
 */
export type ScheduleTranslator = ReturnType<
  typeof useTranslations<'admin.renewals.settings.schedules'>
>;

/**
 * Plain-language timing sentence ("30 days before renewal" / "On
 * renewal date" / "7 days after renewal"). The primary timing label
 * across the StepCard timing dropdown, header badge, EmailPreview, and
 * reminder-timeline node labels.
 */
export function timingSentence(days: number, t: ScheduleTranslator): string {
  if (days === 0) return t('stepCard.timing.onRenewal');
  if (days < 0) return t('stepCard.timing.beforeRenewal', { days: Math.abs(days) });
  return t('stepCard.timing.afterRenewal', { days });
}
