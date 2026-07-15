/**
 * Compose a member's structured postal address into the multi-line string
 * captured on the invoice/receipt buyer block (`MemberIdentitySnapshot.address`).
 *
 * Thai Revenue Code §86/§87 require a tax invoice/receipt to carry the buyer's
 * FULL address (not just a country). The F3 `members` table holds the structured
 * parts (`address_line1/2`, `sub_district`, `city`, `province`, `postal_code`)
 * plus the 2-letter ISO `country`; this builds the human-readable block from
 * whatever parts are present. Lines:
 *
 *   address_line1
 *   address_line2
 *   <sub_district> <city> <province> <postal_code>
 *   <country NAME>
 *
 * Empty/blank parts are dropped. The `country` (always present — required at
 * member creation/import) is appended last, so the result is NEVER empty: a
 * member with no street parts yet degrades gracefully to the bare country name,
 * keeping the snapshot schema's non-empty invariant.
 *
 * 059 / PR-A Task 6a — THE COUNTRY RENDERS AS A NAME, NOT A RAW ISO CODE.
 *
 * This line used to `push(country)` — the raw alpha-2 code — and a real issued
 * invoice ended in a bare line reading `SV`. Two things are wrong with that:
 *
 *   1. §86/4 requires an address that identifies the buyer unambiguously. `SV`
 *      is not an address; a Revenue officer cannot read it.
 *   2. It HIDES DATA ERRORS. `SV` is EL SALVADOR — Sweden is `SE`. The code
 *      passes `asIsoCountryCode` validation (El Salvador is a real country), so
 *      the value is VALID and WRONG, and nobody notices because nobody reads
 *      two-letter codes. Printed as "El Salvador" on a Swedish member's invoice
 *      it is impossible to miss. `src/components/members/country-display.tsx`
 *      already made exactly this fix for the admin screens ("SG" vs "SE" is one
 *      character off and a different country); the tax document never got it.
 *
 * LOCALE — resolved in ENGLISH, deliberately, and independent of the viewer:
 *
 *   - The value is FROZEN into `MemberIdentitySnapshot.address` at ISSUE time
 *     (FR-038) and re-rendered verbatim forever after. It is a property of the
 *     DOCUMENT, not of whoever is looking at it, so it must not depend on a
 *     request-scoped locale — this function is pure and has no i18n context, and
 *     giving it one would make an immutable tax particular vary by viewer.
 *   - EN is the canonical locale, and the buyer block's sibling labels the
 *     template prints alongside it ("Tax ID:", "Member No.") are already English.
 *   - The remaining address lines are stored verbatim as the admin typed them
 *     (Thai or Latin), so the country name is the only part we synthesise.
 *
 * A domestic Thai invoice omits the line entirely when street parts exist (see
 * below), so the EN choice never displaces a Thai address's own convention.
 *
 * Pure — no I/O, no framework imports (the ISO table is a static JSON map) — so
 * it is unit-tested in isolation.
 */
import i18nIsoCountries from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json';

// Register EN once at module load. `registerLocale` is idempotent, and the
// package is already an F3 dependency (zero new deps — Constitution X).
i18nIsoCountries.registerLocale(enLocale as never);

/**
 * ISO 3166-1 alpha-2 → English country name. Falls back to the RAW CODE when
 * the code is unknown to the table: a tax document must never silently lose a
 * particular, and the snapshot schema requires a non-empty address. Uppercases
 * first — `members.country` is stored uppercase, but a lowercase value must
 * still resolve rather than print as junk.
 */
function countryName(code: string): string {
  try {
    return i18nIsoCountries.getName(code.toUpperCase(), 'en') ?? code;
  } catch {
    return code;
  }
}

export interface BuyerAddressParts {
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  /**
   * แขวง/ตำบล. Sits BETWEEN address_line2 and the district on a Thai address.
   * NULL on every legacy row, which is why the locality join must stay
   * blank-dropping — the pre-sub-district output has to remain byte-identical.
   */
  readonly subDistrict: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  /** 2-letter ISO 3166-1 alpha-2; required on every member. */
  readonly country: string;
}

function clean(s: string | null | undefined): string {
  return (s ?? '').trim();
}

export function composeBuyerAddress(parts: BuyerAddressParts): string {
  const lines: string[] = [];

  const line1 = clean(parts.addressLine1);
  if (line1.length > 0) lines.push(line1);

  const line2 = clean(parts.addressLine2);
  if (line2.length > 0) lines.push(line2);

  // City / province / postal collapse onto ONE locality line; each part is
  // optional, joined by a single space, so "Bangkok 10110" or "Khlong Toei
  // Bangkok 10110" render cleanly without dangling separators. subDistrict
  // (แขวง/ตำบล) leads the line — Thai address ordering puts it before the
  // district (`city`) — and is dropped like every other blank part, so
  // legacy rows (sub_district always NULL) render byte-identical.
  const locality = [
    clean(parts.subDistrict),
    clean(parts.city),
    clean(parts.province),
    clean(parts.postalCode),
  ]
    .filter((p) => p.length > 0)
    .join(' ');
  if (locality.length > 0) lines.push(locality);

  const country = clean(parts.country);
  // A domestic Thai tax invoice carries the jurisdiction implicitly in the
  // Thai locality, so a trailing "Thailand" line is redundant (standard Thai
  // tax-doc convention). Suppress it ONLY when the country is TH AND we already
  // have at least one street/locality line. Foreign members keep their country
  // line, and an address-less member still falls back to the bare country name
  // (non-empty invariant). (code-review L-01.) The suppression test runs on the
  // CODE, before resolution — unchanged behaviour.
  const hasStreetParts = lines.length > 0;
  const suppressDomesticCountry =
    country.toUpperCase() === 'TH' && hasStreetParts;
  // §86/4 — the country prints as a NAME ("Sweden"), never the raw `SE`/`SV`
  // code. See the module docblock for why (unreadable particular + it hides a
  // valid-but-wrong code).
  const countryLine = country.length > 0 ? countryName(country) : '';
  if (countryLine.length > 0 && !suppressDomesticCountry) lines.push(countryLine);

  // Always non-empty: `country` is required, so at minimum the bare country name
  // survives (matches the pre-fix behaviour for address-less members, resolved).
  return lines.length > 0 ? lines.join('\n') : countryLine;
}
