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
 *
 * Spec 122 US8c-2 (T856) — an AURA card (board `Admin-invoice-settings`),
 * the rail's focus target, with its fieldsets inside and AURA fields; ids,
 * labels, hints and limits unchanged. The seller branch code keeps its 44px
 * box (088 FR-036, `touchHeight="always"`).
 */
'use client';

import { useTranslations } from 'next-intl';
import { Card, Switch, TextField, Textarea } from '@jirawatpyk/aura-react';

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
    <Card
      as="section"
      id="organization"
      tabIndex={-1}
      className="scroll-mt-24 focus-visible:outline-none"
      title={t('sections.organization')}
      titleId="organization-heading"
      headingLevel={2}
    >
      <div className="flex flex-col gap-[var(--aura-space-6)]">
        {/* Currency — R7 consolidation: tenant-wide ISO-4217 code. F2
            plan module reads this via TenantTaxPolicyPort; this form
            is the ONLY editor after fee-config UI was removed. */}
        <fieldset className="flex flex-col gap-[var(--aura-space-4)]">
          <legend className="mb-[var(--aura-space-3)] text-sm font-semibold">{t('sections.currency')}</legend>
          <TextField
            id="currency_code"
            label={t('labels.currencyCode')}
            hint={t('hints.currencyCode')}
            value={currencyCode}
            onChange={(e) => onCurrencyCodeChange(e.target.value.toUpperCase())}
            disabled={disabled}
            required
            maxLength={3}
            pattern="[A-Z]{3}"
            inputMode="text"
            className="sm:max-w-xs [&_input]:font-mono [&_input]:uppercase"
          />
        </fieldset>

        {/* Identity */}
        <fieldset className="flex flex-col gap-[var(--aura-space-4)]">
          <legend className="mb-[var(--aura-space-3)] text-sm font-semibold">{t('sections.identity')}</legend>
          <div className="grid grid-cols-1 gap-[var(--aura-space-4)] sm:grid-cols-2">
            <TextField
              id="legal_name_th"
              label={t('labels.legalNameTh')}
              value={legalNameTh}
              onChange={(e) => onLegalNameThChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={300}
              lang="th"
            />
            <TextField
              id="legal_name_en"
              label={t('labels.legalNameEn')}
              value={legalNameEn}
              onChange={(e) => onLegalNameEnChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={300}
            />
            <TextField
              id="brand_name"
              label={t('labels.brandName')}
              hint={t('labels.brandNameHint')}
              value={brandName}
              onChange={(e) => onBrandNameChange(e.target.value)}
              disabled={disabled}
              maxLength={100}
              placeholder={t('labels.brandNamePlaceholder')}
              className="sm:col-span-2"
            />
            <TextField
              id="tax_id"
              label={t('labels.taxId')}
              hint={t('hints.taxId')}
              value={taxId}
              onChange={(e) => onTaxIdChange(e.target.value)}
              disabled={disabled}
              required
              pattern="\d{13}"
              maxLength={13}
              inputMode="numeric"
              className="sm:col-span-2 [&_input]:font-mono"
            />
            {/* Multi-line so the admin controls exactly where the §86/4 address
                wraps on the invoice/receipt PDF — each newline becomes a line break
                in the document header (a single-line input stripped them, forcing
                the PDF to auto-wrap at bad points, e.g. splitting "ถนน" from
                "พญาไท"). */}
            <Textarea
              id="addr_th"
              label={t('labels.addressTh')}
              value={addrTh}
              onChange={(e) => onAddrThChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={1000}
              rows={3}
              lang="th"
            />
            <Textarea
              id="addr_en"
              label={t('labels.addressEn')}
              value={addrEn}
              onChange={(e) => onAddrEnChange(e.target.value)}
              disabled={disabled}
              required
              maxLength={1000}
              rows={3}
            />
          </div>
        </fieldset>

        {/* 088 US5 — Seller §86/4 Head-Office / Branch */}
        <fieldset className="flex flex-col gap-[var(--aura-space-4)]">
          <legend className="mb-[var(--aura-space-3)] text-sm font-semibold">{t('sections.seller')}</legend>
          <Switch
            id="seller_ho"
            label={t('labels.sellerIsHeadOffice')}
            description={t('hints.sellerIsHeadOffice')}
            checked={sellerIsHeadOffice}
            onChange={onSellerIsHeadOfficeChange}
            disabled={disabled}
          />
          {!sellerIsHeadOffice ? (
            <TextField
              id="seller_branch"
              label={t('labels.sellerBranchCode')}
              hint={t('hints.sellerBranchCode')}
              value={sellerBranchCode}
              onChange={(e) => onSellerBranchCodeChange(e.target.value)}
              disabled={disabled}
              inputMode="numeric"
              maxLength={5}
              pattern="\d{5}"
              // T072b (FR-036) — ≥44px touch target at every width.
              touchHeight="always"
              className="sm:max-w-xs [&_input]:font-mono"
            />
          ) : null}
        </fieldset>
      </div>
    </Card>
  );
}
