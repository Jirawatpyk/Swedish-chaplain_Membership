/**
 * Thai national tax ID — 13-digit weighted checksum validator.
 *
 * Official algorithm (Revenue Department):
 *   - 13 digits total
 *   - Multiply digits 1..12 by weights 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2
 *   - Take the weighted sum, mod 11, subtract from 11, mod 10 → check digit
 *   - Compare against digit 13
 *
 * Source: Revenue Department Notification Re: Taxpayer Identification Number.
 * Pure TypeScript — no framework imports.
 */

export function validateThaiTaxIdChecksum(taxId: string): boolean {
  if (!/^\d{13}$/.test(taxId)) return false;

  const weights = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    // Cast via Number — taxId[i] is a character '0'..'9'.
    sum += Number(taxId[i]) * weights[i]!;
  }
  const checkDigit = (11 - (sum % 11)) % 10;
  return checkDigit === Number(taxId[12]);
}
