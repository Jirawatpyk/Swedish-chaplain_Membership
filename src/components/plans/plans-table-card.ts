/**
 * A card hides the year: the page is already one year (`Admin-plans-mobile`).
 * AURA app content: which of this page's fields a phone card leaves out (the
 * static Table's `Td` has title / action / field slots, no "hide"). Its own
 * module so the route's skeleton can use it without loading the table.
 */
export const HIDE_IN_CARD = '@max-[640px]/aura-tbl:hidden';

/**
 * The year also steps aside while the table box is narrow (tablet, or a small
 * window with the sidebar open): names wrap between words, so without it the
 * row's ⋯ menu ran past the box's edge. The filter bar already shows the year.
 */
export const HIDE_WHEN_NARROW = '@max-[800px]/aura-tbl:hidden';
