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
 *   <country>
 *
 * Empty/blank parts are dropped. The `country` (always present — required at
 * member creation/import) is appended last, so the result is NEVER empty: a
 * member with no street parts yet degrades gracefully to the bare country code
 * (the prior behaviour), keeping the snapshot schema's non-empty invariant.
 *
 * Pure — no I/O, no framework imports — so it is unit-tested in isolation.
 */
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
  // Thai locality, so a trailing "TH" line is redundant (standard Thai tax-doc
  // convention). Suppress it ONLY when the country is TH AND we already have at
  // least one street/locality line. Foreign members keep their country line, and
  // an address-less member still falls back to the bare country (non-empty
  // invariant). (code-review L-01.)
  const hasStreetParts = lines.length > 0;
  const suppressDomesticCountry =
    country.toUpperCase() === 'TH' && hasStreetParts;
  if (country.length > 0 && !suppressDomesticCountry) lines.push(country);

  // Always non-empty: `country` is required, so at minimum the bare country
  // code survives (matches the pre-fix behaviour for address-less members).
  return lines.length > 0 ? lines.join('\n') : country;
}
