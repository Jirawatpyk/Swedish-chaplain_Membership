/**
 * Task 6 — "Numbering" settings section (document-number prefixes,
 * receipt mode, fiscal year start, default net days, pro-rate policy,
 * auto-email-on-issue).
 *
 * Mechanical extraction from `invoice-settings-form.tsx`'s Numbering
 * fieldset (unchanged) plus the full former "Defaults" fieldset
 * (fiscal-year / net-days / pro-rate / `auto_email_enabled`). Field JSX
 * moved verbatim; only the `useState` reads/writes became props.
 *
 * I2 (wave B, settings-ux-invoice-reminders) — `auto_email_enabled`
 * relocated here FROM `document-notes-section.tsx`: it's a send-behaviour
 * default, not a note, and this is where the rest of the "Defaults"
 * fieldset already lived. Same id/aria-label/binding as its old home —
 * relocation only, no attribute change.
 *
 * `receipt_numbering_mode` is NOT a prop — combined numbering is
 * retired (088 US5 / F.5), so the mode is a fixed, translated,
 * read-only display string, same as the orchestrator.
 *
 * I1 (wave B) — the "Numbering" fieldset's `<legend>` used to repeat the
 * section h2 text verbatim (visible clutter + SR double-announce);
 * it's now `sr-only` (accessible name preserved, visual dupe gone). The
 * "Defaults" fieldset's legend is a distinct key and is unaffected.
 *
 * Controlled + presentational only: no local field state, no PATCH,
 * no validation logic.
 *
 * Spec 122 US8c-2 (T856) — an AURA card (board `Admin-invoice-settings`),
 * the rail's focus target, with its fieldsets inside and AURA fields; ids,
 * labels, hints and limits unchanged. The prefixes and receipt mode keep
 * their 44px boxes (088 FR-036, `touchHeight="always"`).
 */
'use client';

import { useTranslations } from 'next-intl';
import { Card, Select, Switch, TextField } from '@jirawatpyk/aura-react';

export interface NumberingSectionProps {
  readonly invoicePrefix: string;
  readonly onInvoicePrefixChange: (value: string) => void;
  readonly creditPrefix: string;
  readonly onCreditPrefixChange: (value: string) => void;
  readonly receiptPrefix: string;
  readonly onReceiptPrefixChange: (value: string) => void;
  readonly fiscalStartMonth: string;
  readonly onFiscalStartMonthChange: (value: string) => void;
  readonly defaultNetDays: string;
  readonly onDefaultNetDaysChange: (value: string) => void;
  readonly proRate: 'none' | 'monthly' | 'daily';
  readonly onProRateChange: (value: 'none' | 'monthly' | 'daily') => void;
  // I2 (wave B) — auto_email_enabled relocated here from
  // document-notes-section.tsx (it's a send-behaviour default, not a
  // note); same id/aria-label/binding, just a new home next to the rest
  // of the "Defaults" fieldset.
  readonly autoEmail: boolean;
  readonly onAutoEmailChange: (value: boolean) => void;
  readonly disabled: boolean;
}

export function NumberingSection({
  invoicePrefix,
  onInvoicePrefixChange,
  creditPrefix,
  onCreditPrefixChange,
  receiptPrefix,
  onReceiptPrefixChange,
  fiscalStartMonth,
  onFiscalStartMonthChange,
  defaultNetDays,
  onDefaultNetDaysChange,
  proRate,
  onProRateChange,
  autoEmail,
  onAutoEmailChange,
  disabled,
}: NumberingSectionProps) {
  const t = useTranslations('admin.invoiceSettings');

  return (
    <Card
      as="section"
      id="numbering"
      tabIndex={-1}
      className="scroll-mt-24 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aura-focus-ring)]"
      title={t('sections.numbering')}
      titleId="numbering-heading"
      headingLevel={2}
    >
      <div className="flex flex-col gap-[var(--aura-space-6)]">
        {/* The card's h2 names the whole section ("Document numbering"); this
            fieldset holds the number-format prefixes and carries a DISTINCT
            visible legend (not a repeat of the h2), consistent with the
            "Invoicing defaults" fieldset below. */}
        <fieldset>
          <legend className="mb-[var(--aura-space-3)] text-sm font-semibold">{t('sections.numberingPrefixes')}</legend>
          <div className="grid grid-cols-1 gap-[var(--aura-space-4)] sm:grid-cols-2">
            <TextField
              id="inv_prefix"
              label={t('labels.invoicePrefix')}
              touchHeight="always"
              value={invoicePrefix}
              onChange={(e) => onInvoicePrefixChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={20}
            />
            <TextField
              id="cn_prefix"
              label={t('labels.creditNotePrefix')}
              touchHeight="always"
              value={creditPrefix}
              onChange={(e) => onCreditPrefixChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={20}
            />
            {/* 088 US5 (T043 / F.5) — combined numbering is retired; the mode is
                fixed to "separate". Rendered read-only (no longer a selectable). */}
            <TextField
              id="receipt_mode"
              label={t('labels.receiptMode')}
              hint={t('hints.receiptMode')}
              touchHeight="always"
              value={t('receiptMode.separate')}
              readOnly
              disabled
            />
            <TextField
              id="rc_prefix"
              label={t('labels.receiptPrefix')}
              hint={t('hints.receiptPrefix')}
              touchHeight="always"
              value={receiptPrefix}
              onChange={(e) => onReceiptPrefixChange(e.target.value)}
              disabled={disabled}
              maxLength={20}
            />
          </div>
        </fieldset>

        {/* Invoicing defaults (fiscal year / net days / pro-rate). The
            auto_email_enabled toggle was relocated here (I2) and renders
            just after this fieldset. */}
        <fieldset>
          <legend className="mb-[var(--aura-space-3)] text-sm font-semibold">{t('sections.defaults')}</legend>
          <div className="grid grid-cols-1 gap-[var(--aura-space-4)] sm:grid-cols-2">
            <TextField
              id="fy_month"
              label={t('labels.fiscalYearStartMonth')}
              type="number"
              inputMode="numeric"
              min="1"
              max="12"
              step="1"
              value={fiscalStartMonth}
              onChange={(e) => onFiscalStartMonthChange(e.target.value)}
              disabled={disabled}
              required
            />
            <TextField
              id="net_days"
              label={t('labels.defaultNetDays')}
              type="number"
              inputMode="numeric"
              min="0"
              max="365"
              step="1"
              value={defaultNetDays}
              onChange={(e) => onDefaultNetDaysChange(e.target.value)}
              disabled={disabled}
              required
            />
            <Select
              id="pro_rate"
              label={t('labels.proRatePolicy')}
              value={proRate}
              onChange={(e) => onProRateChange(e.target.value as 'none' | 'monthly' | 'daily')}
              disabled={disabled}
              options={[
                { value: 'none', label: t('proRate.none') },
                { value: 'monthly', label: t('proRate.monthly') },
                { value: 'daily', label: t('proRate.daily') },
              ]}
            />
          </div>
        </fieldset>

        {/* auto_email_enabled — relocated here from document-notes-section.tsx
            (I2, wave B): it's a send-behaviour default, not a note, so it sits
            next to the rest of the "Defaults" fieldset. */}
        <Switch
          id="auto_email"
          label={t('labels.autoEmail')}
          description={t('hints.autoEmail')}
          checked={autoEmail}
          onChange={onAutoEmailChange}
          disabled={disabled}
        />
      </div>
    </Card>
  );
}
