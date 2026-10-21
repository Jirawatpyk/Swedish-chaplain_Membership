/**
 * Pair with AURA `fullWidth` (and `touchHeight`) for a button that fills the
 * column on phones only: `<Button fullWidth touchHeight className={FULL_WIDTH_BELOW_SM}>`.
 * Below `sm` the button is AURA's own full-width button (the label wraps with
 * AURA's leading, padding and centring, never under 44px); from `sm` up this
 * puts it back to its natural width on one line. The bare `w-full` class is
 * not the way: it keeps AURA's fixed height and `nowrap`, so a long label (SV)
 * overflows a 320px screen.
 *
 * Stand-in until AURA #165 (a responsive `fullWidth`).
 * `tests/unit/architecture/dialog-footer-touch.test.ts` refuses a bare `w-full`
 * on an AURA button.
 */
export const FULL_WIDTH_BELOW_SM = 'sm:w-auto sm:whitespace-nowrap';
