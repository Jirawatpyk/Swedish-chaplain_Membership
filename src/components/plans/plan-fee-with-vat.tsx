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
      {/* 122 US6 (T603): the fee in bold, then the VAT-inclusive total — on
          a phone on its own line in caption size (board `Admin-plan-detail`). */}
      <strong className="font-semibold">{formatSatangThb(BigInt(feeMinorUnits), locale, currencyCode)}</strong>{' '}
      <span className="text-[var(--aura-fg-secondary)] max-sm:block max-sm:text-xs">
        {t('vatAdded', {
          rate: vatRatePercent,
          total: formatSatangThb(BigInt(totalWithVatMinorUnits), locale, currencyCode),
        })}
      </span>
    </span>
  );
}
