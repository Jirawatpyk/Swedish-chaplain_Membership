/**
 * "36,000.00 THB + 7% VAT = 38,520.00 THB" — a plan fee, the tenant VAT
 * rate and the VAT-inclusive total, in the app's money format. The caller
 * computes the total with the domain's `grossWithVatMinorUnits` (the same
 * integer math the plans list uses) and passes it in.
 */
import { useLocale, useTranslations } from 'next-intl';
import { formatSatangThb } from '@/lib/format-thb';

export interface PlanFeeWithVatProps {
  readonly feeMinorUnits: number;
  readonly totalWithVatMinorUnits: number;
  readonly vatRatePercent: number;
  readonly currencyCode: string;
}

export function PlanFeeWithVat({
  feeMinorUnits,
  totalWithVatMinorUnits,
  vatRatePercent,
  currencyCode,
}: PlanFeeWithVatProps) {
  const locale = useLocale();
  const t = useTranslations('admin.plans.detail');
  return (
    <span data-money-display data-currency={currencyCode}>
      {t('feeWithVat', {
        fee: formatSatangThb(BigInt(feeMinorUnits), locale, currencyCode),
        rate: vatRatePercent,
        total: formatSatangThb(BigInt(totalWithVatMinorUnits), locale, currencyCode),
      })}
    </span>
  );
}
