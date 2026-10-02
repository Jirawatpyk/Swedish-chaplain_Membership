/**
 * 088 FR-036 / SC-011 — the issue form's new controls keep a 44px target at
 * every width, not only on touch (AURA's `touchHeight` stops at 640px). A
 * utility on the AURA field root grows the field box or the choice row; the
 * shared AURA primitives are unchanged.
 *
 * stand-in until AURA #135 (a field and choice-row size that is 44px at every
 * width, for a control whose spec asks for it beyond touch screens).
 */
export const TOUCH_FIELD = '[&_.aura-input]:min-h-11';
export const TOUCH_CHOICES = '[&_.aura-choice]:min-h-11 [&_.aura-choice]:items-center';
