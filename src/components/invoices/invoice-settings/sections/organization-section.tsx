/**
 * Task 6 — "Organization" settings section (currency, tenant legal
 * identity, seller §86/4 head-office/branch).
 *
 * Mechanical extraction from `invoice-settings-form.tsx`'s Currency +
 * Identity + Seller §86/4 fieldsets — field JSX (labels, hints,
 * `aria-*`, patterns, ids) is moved verbatim; only the `useState`
 * reads/writes became props. See the orchestrator for the original
 * per-field provenance comments.
 *
 * Controlled + presentational only: no local field state, no PATCH,
 * no validation logic. The orchestrator owns all of that and threads
 * this section's state slice + setters in as props.
 */
'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';

export interface OrganizationSectionProps {
  readonly currencyCode: string;
  readonly onCurrencyCodeChange: (value: string) => void;
  readonly legalNameTh: string;
  readonly onLegalNameThChange: (value: string) => void;
  readonly legalNameEn: string;
  readonly onLegalNameEnChange: (value: string) => void;
  readonly brandName: string;
  readonly onBrandNameChange: (value: string) => void;
  readonly taxId: string;
  readonly onTaxIdChange: (value: string) => void;
  readonly addrTh: string;
  readonly onAddrThChange: (value: string) => void;
  readonly addrEn: string;
  readonly onAddrEnChange: (value: string) => void;
  /** 088 US5 (T043) — seller §86/4 branch. */
  readonly sellerIsHeadOffice: boolean;
  readonly onSellerIsHeadOfficeChange: (value: boolean) => void;
  readonly sellerBranchCode: string;
  readonly onSellerBranchCodeChange: (value: string) => void;
  readonly disabled: boolean;
}

export function OrganizationSection({
  currencyCode,
  onCurrencyCodeChange,
  legalNameTh,
  onLegalNameThChange,
  legalNameEn,
  onLegalNameEnChange,
  brandName,
  onBrandNameChange,
  taxId,
  onTaxIdChange,
  addrTh,
  onAddrThChange,
  addrEn,
  onAddrEnChange,
  sellerIsHeadOffice,
  onSellerIsHeadOfficeChange,
  sellerBranchCode,
  onSellerBranchCodeChange,
  disabled,
}: OrganizationSectionProps) {
  const t = useTranslations('admin.invoiceSettings');

  return (
    <section
      id="organization"
      aria-labelledby="organization-heading"
      className="flex flex-col gap-[var(--page-section-gap)]"
    >
      <h2
        id="organization-heading"
        data-section-heading
        tabIndex={-1}
        className="font-heading text-base font-semibold"
      >
        {t('sections.organization')}
      </h2>

      {/* Currency — R7 consolidation: tenant-wide ISO-4217 code. F2
          plan module reads this via TenantTaxPolicyPort; this form
          is the ONLY editor after fee-config UI was removed. */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">
          {t('sections.currency')}
        </legend>
        <div className="space-y-2 sm:max-w-xs">
          <Label htmlFor="currency_code">{t('labels.currencyCode')}</Label>
          <Input
            id="currency_code"
            value={currencyCode}
            onChange={(e) => onCurrencyCodeChange(e.target.value.toUpperCase())}
            disabled={disabled}
            required
            maxLength={3}
            pattern="[A-Z]{3}"
            inputMode="text"
            aria-describedby="currency_code_hint"
            className="font-mono uppercase"
          />
          <p id="currency_code_hint" className="text-xs text-muted-foreground">
            {t('hints.currencyCode')}
          </p>
        </div>
      </fieldset>

      {/* Identity */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">
          {t('sections.identity')}
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="legal_name_th">{t('labels.legalNameTh')}</Label>
            <Input
              id="legal_name_th"
              value={legalNameTh}
              onChange={(e) => onLegalNameThChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={300}
              lang="th"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="legal_name_en">{t('labels.legalNameEn')}</Label>
            <Input
              id="legal_name_en"
              value={legalNameEn}
              onChange={(e) => onLegalNameEnChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={300}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="brand_name">{t('labels.brandName')}</Label>
            <Input
              id="brand_name"
              value={brandName}
              onChange={(e) => onBrandNameChange(e.target.value)}
              disabled={disabled}
              maxLength={100}
              placeholder={t('labels.brandNamePlaceholder')}
            />
            <p className="text-xs text-muted-foreground">{t('labels.brandNameHint')}</p>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="tax_id">{t('labels.taxId')}</Label>
            <Input
              id="tax_id"
              value={taxId}
              onChange={(e) => onTaxIdChange(e.target.value)}
              disabled={disabled}
              required
              pattern="\d{13}"
              maxLength={13}
              inputMode="numeric"
              aria-describedby="tax_id_hint"
            />
            <p id="tax_id_hint" className="text-xs text-muted-foreground">
              {t('hints.taxId')}
            </p>
          </div>
          {/* Multi-line so the admin controls exactly where the §86/4 address
              wraps on the invoice/receipt PDF — each newline becomes a line break
              in the document header (a single-line <Input> stripped them, forcing
              the PDF to auto-wrap at bad points, e.g. splitting "ถนน" from
              "พญาไท"). */}
          <div className="space-y-2">
            <Label htmlFor="addr_th">{t('labels.addressTh')}</Label>
            <Textarea
              id="addr_th"
              value={addrTh}
              onChange={(e) => onAddrThChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={1000}
              rows={3}
              lang="th"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="addr_en">{t('labels.addressEn')}</Label>
            <Textarea
              id="addr_en"
              value={addrEn}
              onChange={(e) => onAddrEnChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={1000}
              rows={3}
            />
          </div>
        </div>
      </fieldset>

      {/* 088 US5 — Seller §86/4 Head-Office / Branch */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">{t('sections.seller')}</legend>
        {/* T072b (FR-036) — gap-3 + min-w-0 keep this row from overflowing
            at 320px if a long TH/SV label meets the fixed-width Switch. */}
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="min-w-0">
            <Label htmlFor="seller_ho" className="cursor-pointer">
              {t('labels.sellerIsHeadOffice')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('hints.sellerIsHeadOffice')}
            </p>
          </div>
          <Switch
            id="seller_ho"
            aria-label={t('labels.sellerIsHeadOffice')}
            checked={sellerIsHeadOffice}
            onCheckedChange={onSellerIsHeadOfficeChange}
            disabled={disabled}
          />
        </div>
        {!sellerIsHeadOffice ? (
          <div className="space-y-2 sm:max-w-xs">
            <Label htmlFor="seller_branch">{t('labels.sellerBranchCode')}</Label>
            <Input
              id="seller_branch"
              value={sellerBranchCode}
              onChange={(e) => onSellerBranchCodeChange(e.target.value)}
              disabled={disabled}
              inputMode="numeric"
              maxLength={5}
              pattern="\d{5}"
              aria-describedby="seller_branch_hint"
              // T072b (FR-036) — ≥44px touch target (new US5 input).
              className="min-h-11 font-mono"
            />
            <p id="seller_branch_hint" className="text-xs text-muted-foreground">
              {t('hints.sellerBranchCode')}
            </p>
          </div>
        ) : null}
      </fieldset>
    </section>
  );
}
