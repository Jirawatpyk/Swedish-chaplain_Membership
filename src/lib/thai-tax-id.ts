/**
 * Thai taxpayer identification number — 13-digit weighted checksum.
 *
 * Official algorithm (Revenue Department):
 *   - 13 digits total
 *   - Multiply digits 1..12 by weights 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2
 *   - Take the weighted sum, mod 11, subtract from 11, mod 10 → check digit
 *   - Compare against digit 13
 *
 * Source: Revenue Department Notification Re: Taxpayer Identification Number.
 *
 * WHY THIS LIVES IN `src/lib` AND NOT IN THE MEMBERS DOMAIN (moved 2026-07-15):
 * it is a pure, framework-free tax algorithm that TWO bounded contexts need —
 * F3 members validates a member's stored `tax_id` with it, and F4 invoicing uses
 * it to decide whether a stored identifier is a real Thai TIN it may print on a
 * §86/4 document. A cross-context deep import into `members/domain/**` is
 * blocked by the module-boundary rule (and rightly so), and duplicating a tax
 * algorithm is how two copies quietly diverge. Same category as `result.ts`.
 *
 * Pure TypeScript — no framework imports.
 */

/**
 * True iff `taxId` is exactly 13 digits AND its check digit is correct.
 *
 * This is the ONLY reliable way to tell a genuine Thai TIN from any other
 * identifier a member might have stored in the same column — a foreign passport,
 * a foreign company-registration number — because the check digit makes a
 * coincidental pass vanishingly unlikely. Note that a Thai natural person's TIN
 * IS their 13-digit national ID, so this returns true for an individual just as
 * it does for a juristic person: both are real taxpayer numbers, and both are
 * legitimately printable.
 */
export function isThaiTaxId(taxId: string | null | undefined): boolean {
  const value = (taxId ?? '').trim();
  if (!/^\d{13}$/.test(value)) return false;

  const weights = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    // Cast via Number — value[i] is a character '0'..'9'.
    sum += Number(value[i]) * weights[i]!;
  }
  const checkDigit = (11 - (sum % 11)) % 10;
  return checkDigit === Number(value[12]);
}

/**
 * @deprecated Use {@link isThaiTaxId}. Retained as the name F3's `asTaxId`
 * value object and the member form already call; it takes a plain `string`
 * because both callers have already narrowed away null/undefined.
 */
export function validateThaiTaxIdChecksum(taxId: string): boolean {
  return isThaiTaxId(taxId);
}
