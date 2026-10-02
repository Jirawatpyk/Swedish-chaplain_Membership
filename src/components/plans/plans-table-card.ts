/**
 * A card hides the year: the page is already one year (`Admin-plans-mobile`).
 * AURA app content: which of this page's fields a phone card leaves out (the
 * static Table's `Td` has title / action / field slots, no "hide"). Its own
 * module so the route's skeleton can use it without loading the table.
 */
export const HIDE_IN_CARD = '@max-[640px]/aura-tbl:hidden';
