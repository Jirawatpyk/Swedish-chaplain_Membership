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

/**
 * "T±N" compact formatter. v2 rework (`.superpowers/sdd/rework-
 * stepcard-v2-brief.md`, Issue 4) moved every primary user-facing
 * surface — the timing dropdown, the StepCard header badge, the
 * EmailPreview summary, and the timeline's screen-reader list — to
 * `timingSentence` below (live QA: "T-30" reads as cryptic). Kept here
 * as a small, still-tested utility in case a future raw/Advanced-
 * context display wants the compact form.
 */
export function formatOffset(days: number, t: ScheduleTranslator): string {
  if (days === 0) return t('stepCard.offsetDay.exact');
  if (days < 0) return t('stepCard.offsetDay.before', { days: Math.abs(days) });
  return t('stepCard.offsetDay.after', { days });
}

/**
 * Plain-language timing sentence ("30 days before renewal" / "On
 * renewal date" / "7 days after renewal") — v2 rework Issue 4. Replaces
 * the cryptic "T-30" badge/summary text across the StepCard timing
 * dropdown, header badge, EmailPreview, and reminder-timeline SR list.
 */
export function timingSentence(days: number, t: ScheduleTranslator): string {
  if (days === 0) return t('stepCard.timing.onRenewal');
  if (days < 0) return t('stepCard.timing.beforeRenewal', { days: Math.abs(days) });
  return t('stepCard.timing.afterRenewal', { days });
}
