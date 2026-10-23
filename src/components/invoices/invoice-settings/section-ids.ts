/**
 * The invoice settings sections, in page order: each id is its card's
 * `<section id>`, its tab's `#href` and its tab label key (`tabs.<id>`).
 * A plain module (not `'use client'`), so the server view that renders the
 * tabs and the client form that renders the cards read the same list.
 */
export const INVOICE_SETTINGS_SECTION_IDS = [
  'organization',
  'tax',
  'numbering',
  'notes',
  'payment',
  'branding',
] as const;
