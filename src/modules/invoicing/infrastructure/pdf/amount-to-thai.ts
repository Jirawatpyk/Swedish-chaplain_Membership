/**
 * T043 — Amount → Thai words helper (F4).
 * Wraps the `thai-baht-text` library.
 */
// thai-baht-text v2 default export is the converter function.
import thaiBahtText from 'thai-baht-text';

export function amountToThaiWords(thb: number): string {
  if (thb < 0) throw new Error('amountToThaiWords: negative amount');
  return thaiBahtText(thb);
}
