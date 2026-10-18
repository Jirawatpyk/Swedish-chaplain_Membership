/**
 * Spec 122 US12a (UX L7) — the top margin that sets a control beside an AURA
 * field level with the field's box rather than its label: AURA's
 * `.aura-text-label` line (max(13px, 0.8125rem) × 1.4 line height) plus the
 * field's 6px label gap. A hint or an error below the field never moves it.
 *
 * Both strings are written out in full so Tailwind generates them.
 */
export const FIELD_BOX_OFFSET = 'mt-[calc(max(13px,0.8125rem)*1.4+6px)]';

/** The same offset from 640px up, for a row that stacks on phones. */
export const FIELD_BOX_OFFSET_SM = 'sm:mt-[calc(max(13px,0.8125rem)*1.4+6px)]';
