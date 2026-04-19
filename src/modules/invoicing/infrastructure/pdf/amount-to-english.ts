/**
 * T043 — Amount → English words helper (F4).
 * Minimal in-repo implementation (no dep) — covers up to 999,999,999.99 THB.
 */

const UNDER20 = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function underThousand(n: number): string {
  if (n === 0) return '';
  if (n < 20) return UNDER20[n]!;
  if (n < 100) {
    const t = Math.floor(n / 10);
    const r = n % 10;
    return r === 0 ? TENS[t]! : `${TENS[t]} ${UNDER20[r]}`;
  }
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return rest === 0 ? `${UNDER20[h]} hundred` : `${UNDER20[h]} hundred ${underThousand(rest)}`;
}

function integerToWords(n: number): string {
  if (n === 0) return 'zero';
  const units = [
    [1_000_000_000, 'billion'],
    [1_000_000, 'million'],
    [1_000, 'thousand'],
  ] as const;
  const parts: string[] = [];
  let rem = n;
  for (const [divisor, label] of units) {
    if (rem >= divisor) {
      const chunk = Math.floor(rem / divisor);
      parts.push(`${underThousand(chunk)} ${label}`);
      rem = rem % divisor;
    }
  }
  if (rem > 0) parts.push(underThousand(rem));
  return parts.join(' ').trim();
}

export function amountToEnglishWords(thb: number): string {
  if (thb < 0) throw new Error('amountToEnglishWords: negative amount');
  const thbWhole = Math.floor(thb);
  const satang = Math.round((thb - thbWhole) * 100);
  const base = `${integerToWords(thbWhole)} baht`;
  return satang === 0 ? base : `${base} and ${integerToWords(satang)} satang`;
}
