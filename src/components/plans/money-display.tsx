/**
 * T082 — MoneyDisplay (US1).
 *
 * Renders an integer `minor_units` amount + a `currency_code` in the
 * active locale via `Intl.NumberFormat`. Pure-presentation, no data
 * fetching — the caller (list page, detail page, palette) resolves
 * the currency from `tenant_fee_config.currency_code` once and passes
 * it down the tree.
 */
import { useLocale } from 'next-intl';

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
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const major = amountMinorUnits / Math.pow(10, digits);
  return (
    <span className={className} data-money-display data-currency={currencyCode}>
      {formatter.format(major)}
    </span>
  );
}
