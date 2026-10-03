/**
 * Task 6 — "Tax" settings section (VAT rate, registration fee).
 *
 * Mechanical extraction from `invoice-settings-form.tsx`'s Tax
 * fieldset — field JSX moved verbatim; only the `useState`
 * reads/writes became props.
 *
 * Controlled + presentational only: no local field state, no PATCH,
 * no validation logic.
 *
 * Spec 122 US8c-2 (T856) — an AURA card (board `Admin-invoice-settings`),
 * the rail's focus target, with AURA fields; ids, labels and limits unchanged.
 */
'use client';

import { useTranslations } from 'next-intl';
import { Card, TextField } from '@jirawatpyk/aura-react';

export interface TaxVatSectionProps {
  readonly vatPercent: string;
  readonly onVatPercentChange: (value: string) => void;
  readonly regFee: string;
  readonly onRegFeeChange: (value: string) => void;
  // Minor (wave B) — registration_fee's label interpolates the tenant's
  // current (editable) currency_code instead of a hardcoded "THB".
  readonly currencyCode: string;
  readonly disabled: boolean;
}

export function TaxVatSection({
  vatPercent,
  onVatPercentChange,
  regFee,
  onRegFeeChange,
  currencyCode,
  disabled,
}: TaxVatSectionProps) {
  const t = useTranslations('admin.invoiceSettings');

  return (
    <Card
      as="section"
      id="tax"
      tabIndex={-1}
      className="scroll-mt-24 focus-visible:outline-none"
      title={t('sections.tax')}
      titleId="tax-heading"
      headingLevel={2}
    >
      {/* Tax — the card's h2 already names this section; a visible legend
          repeating the same text was a duplicate SR announcement (I1).
          `sr-only` keeps the fieldset's accessible name without the
          visual clutter. */}
      <fieldset>
        <legend className="sr-only">{t('sections.tax')}</legend>
        <div className="grid grid-cols-1 gap-[var(--aura-space-4)] sm:grid-cols-2">
          <TextField
            id="vat_percent"
            label={t('labels.vatPercent')}
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
          <TextField
            id="reg_fee"
            label={t('labels.registrationFee', { currency: currencyCode })}
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
      </fieldset>
    </Card>
  );
}
