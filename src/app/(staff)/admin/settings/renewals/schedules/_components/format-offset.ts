import type { useTranslations } from 'next-intl';

/**
 * Task 8 — shared offset-sentence formatter, extracted from
 * `schedule-editor.tsx`'s local `formatOffset` (StepRow) and
 * `reminder-timeline.tsx`'s local `offsetLabel` (identical logic,
 * duplicated twice already). A third inline copy in `step-card.tsx`
 * would make three — pulled out to a standalone module instead.
 *
 * `schedule-editor.tsx` itself is intentionally left untouched here —
 * Task 9 consolidates `StepRow` away entirely (this component's
 * replacement), so switching its local helper to this import belongs
 * in that follow-up, not here.
 */
export type ScheduleTranslator = ReturnType<
  typeof useTranslations<'admin.renewals.settings.schedules'>
>;

export function formatOffset(days: number, t: ScheduleTranslator): string {
  if (days === 0) return t('stepCard.offsetDay.exact');
  if (days < 0) return t('stepCard.offsetDay.before', { days: Math.abs(days) });
  return t('stepCard.offsetDay.after', { days });
}
