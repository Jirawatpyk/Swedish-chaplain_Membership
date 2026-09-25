/**
 * Satang decimal string → `"10,700.00"`. Same deterministic formatter the
 * invoice list uses — pinned `'en-US'` grouping per FR-005 for tax-amount
 * display consistency across surfaces. Shared by the credit-note table and
 * its mobile card list so the two can never disagree.
 */
export function formatSatang(sRaw: string): string {
  const n = BigInt(sRaw);
  const abs = n < 0n ? -n : n;
  const sign = n < 0n ? '-' : '';
  return `${sign}${(abs / 100n).toLocaleString('en-US')}.${(abs % 100n).toString().padStart(2, '0')}`;
}
