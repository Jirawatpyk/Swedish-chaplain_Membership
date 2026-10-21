/**
 * A button that stretches to the column on phones only (below `sm`) and keeps
 * its natural width above. AURA's `fullWidth` stretches at every width, and
 * the bare `w-full` class keeps AURA's fixed height and `nowrap`, so a long
 * label (SV) overflows a 320px screen. Below `sm` this lets the label wrap and
 * the button grow, never under the 44px its `touchHeight` gives.
 *
 * Stand-in until AURA #165 (a responsive `fullWidth`); pair it with
 * `touchHeight`. `tests/unit/architecture/dialog-footer-touch.test.ts` refuses
 * a bare `w-full` on an AURA button.
 */
export const PHONE_FULL_WIDTH_BUTTON = 'max-sm:w-full max-sm:h-auto max-sm:min-h-11 max-sm:whitespace-normal';
