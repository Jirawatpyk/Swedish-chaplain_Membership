import { Money } from './money';

/**
 * Back-calculate the VAT-exclusive subtotal + VAT from a VAT-INCLUSIVE total
 * (event ticket prices are all-in). `rateBps` = VAT rate in basis points
 * (700n = 7%). subtotal = total × 10000/(10000+rateBps) rounded half-away-from-
 * zero (Money.multiplyByFraction), vat = total − subtotal (derived → the
 * invariant subtotal+vat===total holds exactly). Pure, no I/O.
 */
export function splitVatInclusive(
  total: Money,
  rateBps: bigint,
): { subtotal: Money; vat: Money } {
  if (rateBps < 0n) throw new Error('splitVatInclusive: rateBps must be >= 0');
  const subtotal = total.multiplyByFraction(10_000n, 10_000n + rateBps);
  const sub = total.subtract(subtotal);
  if (!sub.ok) throw new Error('splitVatInclusive: subtotal exceeds total');
  return { subtotal, vat: sub.value };
}
