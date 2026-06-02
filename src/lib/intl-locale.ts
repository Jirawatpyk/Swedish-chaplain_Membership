/**
 * Locale helpers for Intl date/number formatting.
 *
 * Thai membership surfaces display the YEAR in Buddhist Era (BE = CE + 543).
 * This is **display-only** — storage is always ISO 8601 UTC Gregorian
 * (CLAUDE.md § Conventions; storing BE is an off-by-543 ship blocker).
 *
 * `dateFormatLocale` appends the `-u-ca-buddhist` Unicode calendar extension
 * for Thai so ICU renders BE **explicitly**, rather than depending on the host
 * ICU build's default calendar for the bare `th` locale (which varies between
 * Node/V8 versions — the bug class behind the F9 "BE not applied on N admin
 * date instances" + invoicing "risk Buddhist-Era year under full ICU"
 * findings). Mirrors the ad-hoc `locale === 'th' ? 'th-TH-u-ca-buddhist' :
 * locale` idiom already used in broadcasts, e-blast quota-banner, and the
 * portal credit-note surfaces — centralised here so every general date
 * surface renders Thai dates consistently.
 *
 * Scope: use for GENERAL date surfaces (dashboards, detail pages, lists,
 * audit timestamps). Thai **tax documents** (invoice/credit-note PDFs + their
 * admin detail headers) use a separate `CE (พ.ศ. xxxx)` parenthetical
 * treatment for legal dual-calendar clarity and MUST NOT be routed through
 * this helper — see `src/app/(staff)/admin/credit-notes/*`.
 */
export function dateFormatLocale(locale: string): string {
  return locale === 'th' || locale === 'th-TH' ? 'th-TH-u-ca-buddhist' : locale;
}
