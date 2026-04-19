/**
 * R7-B2 — InvoiceSettingsForm (F4 US4 / FR-009 / FR-034).
 *
 * Client component. Flat form with sections:
 *   1. Tenant legal identity — legal_name_th, legal_name_en, tax_id,
 *      registered_address_th, registered_address_en
 *   2. Tax — vat_rate (percent input), registration_fee (major-units)
 *   3. Numbering — invoice_number_prefix, credit_note_number_prefix,
 *      receipt_numbering_mode, receipt_number_prefix
 *   4. Defaults — fiscal_year_start_month, default_net_days,
 *      pro_rate_policy, auto_email_enabled
 *   5. Logo — file upload (PNG/JPEG, ≤ 1 MB, 200×100..2000×500 px)
 *
 * On submit: PATCH /api/tenant-invoice-settings with the full shape.
 * Logo is uploaded SEPARATELY (POST /logo) on file-select; the
 * returned key is patched into the form's hidden logo_blob_key field
 * and flushed with the rest on save.
 *
 * RBAC mirror: manager is read-only — disables inputs + hides save.
 * Security boundary is the PATCH route guard, not this UX.
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

export interface InvoiceSettingsFormInitialValues {
  readonly legal_name_th: string;
  readonly legal_name_en: string;
  readonly tax_id: string;
  readonly registered_address_th: string;
  readonly registered_address_en: string;
  readonly vat_percent: string; // "7.00" (UI) — persisted as 0.0700
  readonly registration_fee_baht: string; // major units
  readonly invoice_number_prefix: string;
  readonly credit_note_number_prefix: string;
  readonly receipt_numbering_mode: 'combined' | 'separate';
  readonly receipt_number_prefix: string | null;
  readonly fiscal_year_start_month: number; // 1-12
  readonly default_net_days: number; // 0-365
  readonly pro_rate_policy: 'none' | 'monthly' | 'daily';
  readonly auto_email_enabled: boolean;
  readonly logo_blob_key: string | null;
}

export interface InvoiceSettingsFormProps {
  readonly initialValues: InvoiceSettingsFormInitialValues;
  readonly currentUserRole: 'admin' | 'manager' | 'member';
  readonly exists: boolean; // false on first-ever load
}

export function InvoiceSettingsForm({
  initialValues,
  currentUserRole,
  exists,
}: InvoiceSettingsFormProps) {
  const t = useTranslations('admin.invoiceSettings');
  const router = useRouter();
  const isAdmin = currentUserRole === 'admin';

  const [legalNameTh, setLegalNameTh] = useState(initialValues.legal_name_th);
  const [legalNameEn, setLegalNameEn] = useState(initialValues.legal_name_en);
  const [taxId, setTaxId] = useState(initialValues.tax_id);
  const [addrTh, setAddrTh] = useState(initialValues.registered_address_th);
  const [addrEn, setAddrEn] = useState(initialValues.registered_address_en);
  const [vatPercent, setVatPercent] = useState(initialValues.vat_percent);
  const [regFee, setRegFee] = useState(initialValues.registration_fee_baht);
  const [invoicePrefix, setInvoicePrefix] = useState(initialValues.invoice_number_prefix);
  const [creditPrefix, setCreditPrefix] = useState(initialValues.credit_note_number_prefix);
  const [receiptMode, setReceiptMode] = useState<'combined' | 'separate'>(
    initialValues.receipt_numbering_mode,
  );
  const [receiptPrefix, setReceiptPrefix] = useState(
    initialValues.receipt_number_prefix ?? '',
  );
  const [fiscalStartMonth, setFiscalStartMonth] = useState(
    String(initialValues.fiscal_year_start_month),
  );
  const [defaultNetDays, setDefaultNetDays] = useState(
    String(initialValues.default_net_days),
  );
  const [proRate, setProRate] = useState<'none' | 'monthly' | 'daily'>(
    initialValues.pro_rate_policy,
  );
  const [autoEmail, setAutoEmail] = useState(initialValues.auto_email_enabled);
  const [logoBlobKey, setLogoBlobKey] = useState<string | null>(
    initialValues.logo_blob_key,
  );

  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = !isAdmin || submitting;

  async function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoError(null);
    setUploadingLogo(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/tenant-invoice-settings/logo', {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        const code = body.error?.code ?? 'generic';
        setLogoError(t(`logo.errors.${code as 'mime_rejected' | 'too_large' | 'dimensions_out_of_range' | 'decode_failed' | 'generic'}`));
        return;
      }
      const body = (await res.json()) as { logo_blob_key: string };
      setLogoBlobKey(body.logo_blob_key);
      toast.success(t('logo.toast.uploaded'));
    } catch {
      setLogoError(t('logo.errors.generic'));
    } finally {
      setUploadingLogo(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!isAdmin) return;
    setSubmitting(true);
    setError(null);

    // Percent → 4-dp decimal string. Guard against Number.parseFloat
    // returning NaN on empty input.
    const vatNum = Number.parseFloat(vatPercent);
    if (Number.isNaN(vatNum) || vatNum < 0 || vatNum > 30) {
      setError(t('errors.vatRange'));
      setSubmitting(false);
      return;
    }
    const vatDecimalString = (vatNum / 100).toFixed(4);

    // Major units → satang (bigint serialised as string).
    const regFeeMajor = Number.parseFloat(regFee);
    if (Number.isNaN(regFeeMajor) || regFeeMajor < 0) {
      setError(t('errors.regFeeRange'));
      setSubmitting(false);
      return;
    }
    const regFeeSatang = String(Math.round(regFeeMajor * 100));

    const fiscalMonth = Number.parseInt(fiscalStartMonth, 10);
    const netDays = Number.parseInt(defaultNetDays, 10);
    if (Number.isNaN(fiscalMonth) || fiscalMonth < 1 || fiscalMonth > 12) {
      setError(t('errors.fiscalMonth'));
      setSubmitting(false);
      return;
    }
    if (Number.isNaN(netDays) || netDays < 0 || netDays > 365) {
      setError(t('errors.netDays'));
      setSubmitting(false);
      return;
    }

    const body = {
      legal_name_th: legalNameTh,
      legal_name_en: legalNameEn,
      tax_id: taxId,
      registered_address_th: addrTh,
      registered_address_en: addrEn,
      vat_rate: vatDecimalString,
      registration_fee_satang: regFeeSatang,
      invoice_number_prefix: invoicePrefix,
      credit_note_number_prefix: creditPrefix,
      receipt_numbering_mode: receiptMode,
      receipt_number_prefix: receiptPrefix.trim() === '' ? null : receiptPrefix,
      fiscal_year_start_month: fiscalMonth,
      default_net_days: netDays,
      pro_rate_policy: proRate,
      auto_email_enabled: autoEmail,
      ...(logoBlobKey !== null && { logo_blob_key: logoBlobKey }),
    };

    try {
      const res = await fetch('/api/tenant-invoice-settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(exists ? t('toast.updated') : t('toast.created'));
        router.refresh();
        setSubmitting(false);
        return;
      }
      const errBody = (await res.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      const code = errBody.error?.code ?? 'generic';
      if (code === 'vat_rate_out_of_range') setError(t('errors.vatRange'));
      else if (res.status === 400) setError(t('errors.validation'));
      else if (res.status === 403) setError(t('errors.forbidden'));
      else setError(t('errors.generic'));
    } catch {
      setError(t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8" noValidate>
      {/* Identity */}
      <section className="space-y-4" aria-labelledby="sect-identity">
        <h3 id="sect-identity" className="text-sm font-semibold">
          {t('sections.identity')}
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="legal_name_th">{t('labels.legalNameTh')}</Label>
            <Input
              id="legal_name_th"
              value={legalNameTh}
              onChange={(e) => setLegalNameTh(e.target.value)}
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
              onChange={(e) => setLegalNameEn(e.target.value)}
              disabled={disabled}
              required
              maxLength={300}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="tax_id">{t('labels.taxId')}</Label>
            <Input
              id="tax_id"
              value={taxId}
              onChange={(e) => setTaxId(e.target.value)}
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
          <div className="space-y-2">
            <Label htmlFor="addr_th">{t('labels.addressTh')}</Label>
            <Input
              id="addr_th"
              value={addrTh}
              onChange={(e) => setAddrTh(e.target.value)}
              disabled={disabled}
              required
              maxLength={1000}
              lang="th"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="addr_en">{t('labels.addressEn')}</Label>
            <Input
              id="addr_en"
              value={addrEn}
              onChange={(e) => setAddrEn(e.target.value)}
              disabled={disabled}
              required
              maxLength={1000}
            />
          </div>
        </div>
      </section>

      {/* Tax */}
      <section className="space-y-4" aria-labelledby="sect-tax">
        <h3 id="sect-tax" className="text-sm font-semibold">
          {t('sections.tax')}
        </h3>
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
              onChange={(e) => setVatPercent(e.target.value)}
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
              onChange={(e) => setRegFee(e.target.value)}
              disabled={disabled}
              required
            />
          </div>
        </div>
      </section>

      {/* Numbering */}
      <section className="space-y-4" aria-labelledby="sect-numbering">
        <h3 id="sect-numbering" className="text-sm font-semibold">
          {t('sections.numbering')}
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="inv_prefix">{t('labels.invoicePrefix')}</Label>
            <Input
              id="inv_prefix"
              value={invoicePrefix}
              onChange={(e) => setInvoicePrefix(e.target.value)}
              disabled={disabled}
              required
              maxLength={20}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cn_prefix">{t('labels.creditNotePrefix')}</Label>
            <Input
              id="cn_prefix"
              value={creditPrefix}
              onChange={(e) => setCreditPrefix(e.target.value)}
              disabled={disabled}
              required
              maxLength={20}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="receipt_mode">{t('labels.receiptMode')}</Label>
            <Select
              value={receiptMode}
              onValueChange={(v) => setReceiptMode(v as 'combined' | 'separate')}
              disabled={disabled}
            >
              <SelectTrigger id="receipt_mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="combined">{t('receiptMode.combined')}</SelectItem>
                <SelectItem value="separate">{t('receiptMode.separate')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rc_prefix">{t('labels.receiptPrefix')}</Label>
            <Input
              id="rc_prefix"
              value={receiptPrefix}
              onChange={(e) => setReceiptPrefix(e.target.value)}
              disabled={disabled || receiptMode === 'combined'}
              maxLength={20}
              aria-describedby="rc_prefix_hint"
            />
            <p id="rc_prefix_hint" className="text-xs text-muted-foreground">
              {t('hints.receiptPrefix')}
            </p>
          </div>
        </div>
      </section>

      {/* Defaults */}
      <section className="space-y-4" aria-labelledby="sect-defaults">
        <h3 id="sect-defaults" className="text-sm font-semibold">
          {t('sections.defaults')}
        </h3>
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
              onChange={(e) => setFiscalStartMonth(e.target.value)}
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
              onChange={(e) => setDefaultNetDays(e.target.value)}
              disabled={disabled}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pro_rate">{t('labels.proRatePolicy')}</Label>
            <Select
              value={proRate}
              onValueChange={(v) => setProRate(v as 'none' | 'monthly' | 'daily')}
              disabled={disabled}
            >
              <SelectTrigger id="pro_rate" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('proRate.none')}</SelectItem>
                <SelectItem value="monthly">{t('proRate.monthly')}</SelectItem>
                <SelectItem value="daily">{t('proRate.daily')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="auto_email" className="cursor-pointer">
                {t('labels.autoEmail')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('hints.autoEmail')}</p>
            </div>
            <Switch
              id="auto_email"
              checked={autoEmail}
              onCheckedChange={setAutoEmail}
              disabled={disabled}
            />
          </div>
        </div>
      </section>

      {/* Logo */}
      <section className="space-y-4" aria-labelledby="sect-logo">
        <h3 id="sect-logo" className="text-sm font-semibold">
          {t('sections.logo')}
        </h3>
        <div className="space-y-2">
          <Label htmlFor="logo_file">{t('labels.logo')}</Label>
          <Input
            id="logo_file"
            type="file"
            accept="image/png,image/jpeg"
            onChange={handleLogoChange}
            disabled={disabled || uploadingLogo}
            aria-describedby="logo_hint logo_status"
            className="cursor-pointer file:cursor-pointer hover:bg-accent/40"
          />
          <p id="logo_hint" className="text-xs text-muted-foreground">
            {t('hints.logo')}
          </p>
          <p id="logo_status" className="text-xs" aria-live="polite">
            {uploadingLogo ? (
              <span className="text-muted-foreground">{t('logo.uploading')}</span>
            ) : logoBlobKey ? (
              <span className="text-muted-foreground">
                {t('logo.currentKey')}: <span className="font-mono">{logoBlobKey}</span>
              </span>
            ) : null}
          </p>
          {logoError ? (
            <p className="text-sm text-destructive" role="alert">
              {logoError}
            </p>
          ) : null}
        </div>
      </section>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {isAdmin ? (
        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting
            ? t('saving')
            : exists
              ? t('actions.save')
              : t('actions.create')}
        </Button>
      ) : null}
    </form>
  );
}
