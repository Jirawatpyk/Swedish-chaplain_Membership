/**
 * Spec 122 — class strings for the few shell controls AURA has no component
 * for (the language pill, the account and search triggers on the `topbar()`
 * boards). They use AURA's tokens so they sit beside AURA's own buttons.
 */

/** AURA's focus ring: the same colour, width and offset as its components. */
export const AURA_FOCUS_RING =
  'focus-visible:outline-solid focus-visible:outline-[length:var(--aura-focus-ring-width)] focus-visible:outline-offset-[var(--aura-focus-ring-offset)] focus-visible:outline-[var(--aura-focus-ring)]';

/**
 * On a static AURA `Table` row: while the table box is the narrowest grid
 * (640–720px, a tablet in portrait), the cells sit 8px apart instead of 16px,
 * so a six- or seven-column row keeps its last column in view. The outer
 * edges keep AURA's padding, so the row still lines up with its card
 * (stand-in until AURA #174).
 */
export const TIGHT_CELLS_IN_NARROWEST_GRID =
  '@min-[640px]/aura-tbl:@max-[720px]/aura-tbl:[&>:not(:first-child)]:pl-[var(--aura-space-2)] @min-[640px]/aura-tbl:@max-[720px]/aura-tbl:[&>:not(:last-child)]:pr-[var(--aura-space-2)]';
