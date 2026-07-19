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
 */
'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';

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
    <section
      id="numbering"
      aria-labelledby="numbering-heading"
      className="flex flex-col gap-[var(--page-section-gap)]"
    >
      <h2
        id="numbering-heading"
        data-section-heading
        tabIndex={-1}
        className="font-heading text-base font-semibold"
      >
        {t('sections.numbering')}
      </h2>

      {/* The section h2 above names the whole section ("Document
          numbering"); this fieldset holds the number-format prefixes and
          carries a DISTINCT visible legend (not a repeat of the h2) so the
          box reads as a titled group, consistent with the "Invoicing
          defaults" fieldset below. (I1 first made this sr-only, which left
          the box looking heading-less next to its labelled sibling.) */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">
          {t('sections.numberingPrefixes')}
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="inv_prefix">{t('labels.invoicePrefix')}</Label>
            <Input
              id="inv_prefix"
              className="min-h-11"
              value={invoicePrefix}
              onChange={(e) => onInvoicePrefixChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={20}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cn_prefix">{t('labels.creditNotePrefix')}</Label>
            <Input
              id="cn_prefix"
              className="min-h-11"
              value={creditPrefix}
              onChange={(e) => onCreditPrefixChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={20}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="receipt_mode">{t('labels.receiptMode')}</Label>
            {/* 088 US5 (T043 / F.5) — combined numbering is retired; the mode is
                fixed to "separate". Rendered read-only (no longer a selectable). */}
            <Input
              id="receipt_mode"
              className="min-h-11"
              value={t('receiptMode.separate')}
              readOnly
              disabled
              aria-describedby="receipt_mode_hint"
            />
            <p id="receipt_mode_hint" className="text-xs text-muted-foreground">
              {t('hints.receiptMode')}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rc_prefix">{t('labels.receiptPrefix')}</Label>
            <Input
              id="rc_prefix"
              className="min-h-11"
              value={receiptPrefix}
              onChange={(e) => onReceiptPrefixChange(e.target.value)}
              disabled={disabled}
              maxLength={20}
              aria-describedby="rc_prefix_hint"
            />
            <p id="rc_prefix_hint" className="text-xs text-muted-foreground">
              {t('hints.receiptPrefix')}
            </p>
          </div>
        </div>
      </fieldset>

      {/* Invoicing defaults (fiscal year / net days / pro-rate). The
          auto_email_enabled toggle was relocated here (I2) and renders
          just after this fieldset. */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">
          {t('sections.defaults')}
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="fy_month">{t('labels.fiscalYearStartMonth')}</Label>
            <Input
              id="fy_month"
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
          </div>
          <div className="space-y-2">
            <Label htmlFor="net_days">{t('labels.defaultNetDays')}</Label>
            <Input
              id="net_days"
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
          </div>
          <div className="space-y-2">
            <Label htmlFor="pro_rate">{t('labels.proRatePolicy')}</Label>
            <Select
              value={proRate}
              onValueChange={(v) => onProRateChange(v as 'none' | 'monthly' | 'daily')}
              disabled={disabled}
            >
              <SelectTrigger id="pro_rate" className="w-full">
                <TranslatedSelectValue
                  translate={(value) => t(`proRate.${value as 'none' | 'monthly' | 'daily'}`)}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('proRate.none')}</SelectItem>
                <SelectItem value="monthly">{t('proRate.monthly')}</SelectItem>
                <SelectItem value="daily">{t('proRate.daily')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </fieldset>

      {/* auto_email_enabled — relocated here from document-notes-section.tsx
          (I2, wave B): it's a send-behaviour default, not a note, so it now
          sits next to the rest of the "Defaults" fieldset. It was never its
          own <fieldset> at its old home either (a standalone bordered
          <div>), so it stays that way here — id/aria-label/binding
          unchanged. */}
      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <Label htmlFor="auto_email" className="cursor-pointer">
            {t('labels.autoEmail')}
          </Label>
          <p className="text-xs text-muted-foreground">{t('hints.autoEmail')}</p>
        </div>
        {/* Base UI Switch.Root renders a <span role="switch"> and wires its
            own aria-labelledby on hydration, so the <Label htmlFor> above
            names it only once the client bundle runs. axe scanning the
            pre-hydration DOM sees no accessible name (aria-toggle-field-name,
            WCAG 4.1.2). The explicit aria-label ships in the SSR HTML and
            covers that window; aria-labelledby still wins afterwards, and
            resolves to the same string. Same fix as directory-visibility-form
            and renewal-reminders-toggle. */}
        <Switch
          id="auto_email"
          aria-label={t('labels.autoEmail')}
          checked={autoEmail}
          onCheckedChange={onAutoEmailChange}
          disabled={disabled}
        />
      </div>
    </section>
  );
}
