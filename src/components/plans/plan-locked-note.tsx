/**
 * 122 US6 (T604) — the words a screen reader hears on each locked field of
 * a prior-year plan ("Locked: historical plan"). The edit form renders this
 * once; every locked field points `aria-describedby` at it, alongside AURA's
 * lock icon (spec Clarifications, Session 2026-09-30 US6 start).
 */
import { useTranslations } from 'next-intl';

export const PLAN_LOCKED_NOTE_ID = 'plan-locked-note';

export function PlanLockedNote() {
  const t = useTranslations('admin.plans.priorYearLock');
  return (
    <span id={PLAN_LOCKED_NOTE_ID} className="sr-only">
      {t('lockedField')}
    </span>
  );
}

/** The props a locked text, number or money field takes. */
export function lockedFieldProps(locked: boolean): {
  readOnly?: true;
  icon?: 'lock';
  'aria-describedby'?: string;
} {
  return locked ? { readOnly: true, icon: 'lock', 'aria-describedby': PLAN_LOCKED_NOTE_ID } : {};
}

/** The props a locked Select takes (a select cannot be read-only yet: stand-in until AURA #114, Addendum 20). */
export function lockedSelectProps(locked: boolean): {
  disabled?: true;
  icon?: 'lock';
  'aria-describedby'?: string;
} {
  return locked ? { disabled: true, icon: 'lock', 'aria-describedby': PLAN_LOCKED_NOTE_ID } : {};
}
