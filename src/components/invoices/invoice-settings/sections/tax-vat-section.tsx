/**
 * Task 6 — "Tax" settings section (VAT rate, registration fee).
 *
 * Mechanical extraction from `invoice-settings-form.tsx`'s Tax
 * fieldset — field JSX moved verbatim; only the `useState`
 * reads/writes became props.
 *
 * Controlled + presentational only: no local field state, no PATCH,
 * no validation logic.
 */
'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface TaxVatSectionProps {
  readonly vatPercent: string;
  readonly onVatPercentChange: (value: string) => void;
  readonly regFee: string;
  readonly onRegFeeChange: (value: string) => void;
  readonly disabled: boolean;
}

export function TaxVatSection({
  vatPercent,
  onVatPercentChange,
  regFee,
  onRegFeeChange,
  disabled,
}: TaxVatSectionProps) {
  const t = useTranslations('admin.invoiceSettings');

  return (
    <section
      id="tax"
      aria-labelledby="tax-heading"
      className="flex flex-col gap-[var(--page-section-gap)]"
    >
      <h2
        id="tax-heading"
        data-section-heading
        tabIndex={-1}
        className="font-heading text-base font-semibold"
      >
        {t('sections.tax')}
      </h2>

      {/* Tax */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">
          {t('sections.tax')}
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="vat_percent">{t('labels.vatPercent')}</Label>
            <Input
              id="vat_percent"
              type="number"
              inputMode="decimal"
              min="0"
              max="30"
              step="0.01"
              value={vatPercent}
              onChange={(e) => onVatPercentChange(e.target.value)}
              disabled={disabled}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reg_fee">{t('labels.registrationFee')}</Label>
            <Input
              id="reg_fee"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={regFee}
              onChange={(e) => onRegFeeChange(e.target.value)}
              disabled={disabled}
              required
            />
          </div>
        </div>
      </fieldset>
    </section>
  );
}
