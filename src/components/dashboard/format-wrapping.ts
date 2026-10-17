/**
 * Spec 122 US11 — a currency amount for display with ordinary spaces between
 * Intl's parts. Intl joins the currency and the number with a no-break space,
 * which kept "THB 381,450" on one line wider than a tile at 200% text. Only
 * the `literal` parts change; a no-break thousands separator (`group`, e.g.
 * Swedish) stays, so a number never splits inside. Screen-reader copies keep
 * Intl's own string.
 */
export function formatWrapping(fmt: Intl.NumberFormat, n: number): string {
  return fmt
    .formatToParts(n)
    .map((p) => (p.type === 'literal' ? p.value.replace(/\u00a0|\u202f/g, ' ') : p.value))
    .join('');
}
