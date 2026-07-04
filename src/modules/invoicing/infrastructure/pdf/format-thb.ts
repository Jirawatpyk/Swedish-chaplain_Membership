/**
 * 088-invoice-tax-flow-redesign — T034 / T035 [US4] deterministic, locale-
 * independent THB formatting helpers for the tax-document PDF template
 * (FR-009).
 *
 * Extracted OUT of `templates/invoice-template.tsx` so the unit test
 * (`tests/unit/invoicing/format-thb.test.ts`) can import these pure functions
 * WITHOUT pulling in `@react-pdf/renderer` + the heavyweight Sarabun font
 * registration (that lives behind the template import).
 *
 * SC-003: `formatThbSatang`'s thousands grouping is OPT-IN (`grouped` defaults
 * false). The default (ungrouped) output is BYTE-IDENTICAL to the pre-v6
 * formatter, so a pinned v1-v5 template re-renders with the SAME bytes; only a
 * v6+ template passes `grouped: true`.
 */

/**
 * Group the integer part of a number with `,` thousands separators.
 *
 * Deterministic + locale-independent by construction: a manual digit-triplet
 * regex (`\B(?=(\d{3})+(?!\d))`), NEVER `Number.prototype.toLocaleString`,
 * whose separator + grouping vary with the ambient ICU locale (a `de-DE`
 * runtime would emit `1.234.567`). Handles a leading `-` sign defensively even
 * though tax-document amounts are non-negative.
 */
function groupInteger(intStr: string): string {
  const negative = intStr.startsWith('-');
  const digits = negative ? intStr.slice(1) : intStr;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/**
 * Format a satang bigint as a THB decimal string (two decimal places).
 *
 * @param satang  amount in satang (1/100 THB)
 * @param grouped when true (v6+ / FR-009) group the integer part with `,`
 *   thousands separators. Default false keeps the pre-v6 output byte-identical.
 *
 * When `grouped` is false the returned string is byte-for-byte the historical
 * `${whole}.${rem.padStart(2,'0')}` output — the decimal handling is left
 * untouched so only the integer part changes when grouping is requested.
 */
export function formatThbSatang(satang: bigint, grouped = false): string {
  const whole = satang / 100n;
  const rem = satang % 100n;
  const wholeStr = grouped ? groupInteger(whole.toString()) : whole.toString();
  return `${wholeStr}.${rem.toString().padStart(2, '0')}`;
}

/**
 * Capitalize the first character of a string, leaving the rest untouched
 * (FR-009 — the English amount-in-words reads as a sentence: "One thousand
 * seventy baht"). Deterministic: `toUpperCase()` on a single ASCII letter is
 * locale-invariant. A no-op on the empty string.
 */
export function capitalizeFirstLetter(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}
