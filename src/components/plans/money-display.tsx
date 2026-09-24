/**
 * T082 — MoneyDisplay (US1).
 *
 * Renders an integer `minor_units` amount + a `currency_code` in the
 * app's money format — "36,000.00 THB" via the shared `formatSatangThb`
 * (suffix style, the same string invoices, payments and the member plan
 * picker show). Grouping follows the active locale. Pure-presentation, no
 * data fetching — the caller (list page, detail page, palette) resolves
 * the currency from the tenant tax policy once and passes it down.
 */
import { useLocale } from 'next-intl';
import { formatSatangThb } from '@/lib/format-thb';

export interface MoneyDisplayProps {
  readonly amountMinorUnits: number;
  readonly currencyCode: string;
  readonly className?: string;
}

export function MoneyDisplay({
  amountMinorUnits,
  currencyCode,
  className,
}: MoneyDisplayProps) {
  const locale = useLocale();
  return (
    <span className={className} data-money-display data-currency={currencyCode}>
      {formatSatangThb(BigInt(amountMinorUnits), locale, currencyCode)}
    </span>
  );
}
