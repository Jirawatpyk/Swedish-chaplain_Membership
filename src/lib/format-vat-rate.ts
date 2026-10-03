/**
 * VAT rate display for the admin invoicing UI — one rendering on every
 * surface (Issue dialog, invoice detail totals, event-fee preview): the rate
 * trimmed to its significant digits and formatted for the UI locale
 * (ux-standards § 12.5 — never a hardcoded decimal separator).
 *
 * Rates travel as basis points (`VatRate.numerator`: 0.0700 → 700), a plain
 * number that crosses the RSC → client boundary. Display only — tax documents
 * (PDFs) keep their own fixed formatting (`VatRate.toPercentString()`,
 * "7.00%") on purpose — a §86/4 document is bilingual and locale-independent.
 *
 * Client-safe leaf: no imports.
 */

/** 700 → '7%', 750 → '7.5%' (en) / '7,5 %' (sv, non-breaking space). */
export function formatVatRateBps(rateBps: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(
    rateBps / 10_000,
  );
}
