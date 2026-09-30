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

/** The props a locked Select takes: read-only since AURA 5.19, so it stays in the tab order. */
export function lockedSelectProps(locked: boolean): {
  readOnly?: true;
  icon?: 'lock';
  'aria-describedby'?: string;
} {
  return locked ? { readOnly: true, icon: 'lock', 'aria-describedby': PLAN_LOCKED_NOTE_ID } : {};
}

/** The props a locked Switch takes: read-only with the lock at the end of its row (AURA 5.19). */
export function lockedSwitchProps(locked: boolean): {
  readOnly?: true;
  icon?: 'lock';
  'aria-describedby'?: string;
} {
  return locked ? { readOnly: true, icon: 'lock', 'aria-describedby': PLAN_LOCKED_NOTE_ID } : {};
}
