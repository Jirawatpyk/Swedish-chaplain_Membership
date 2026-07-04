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
import { Loader2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export interface InvoiceSettingsFormInitialValues {
  readonly currency_code: string; // ISO 4217 (e.g. "THB")
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
  // 088 US5 (T043) — seller §86/4 branch + WHT note + offline-payment bank block.
  readonly seller_is_head_office: boolean;
  readonly seller_branch_code: string | null;
  readonly wht_note_th: string | null;
  readonly wht_note_en: string | null;
  readonly bank_payee_name: string | null;
  readonly bank_account_no: string | null;
  readonly bank_account_type: string | null;
  readonly bank_name: string | null;
  readonly bank_branch: string | null;
  readonly bank_address: string | null;
  readonly bank_swift: string | null;
  readonly payment_instructions_th: string | null;
  readonly payment_instructions_en: string | null;
}

// 088 US5 (T043b) — client-side format guards. The DB CHECK + route zod are the
// real boundaries; these give fast inline feedback.
const SWIFT_RE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const ACCOUNT_NO_RE = /^[0-9][0-9\s-]{3,}$/;
const BRANCH_CODE_RE = /^\d{5}$/;

const WHT_MAX = 500;
const INSTRUCTIONS_MAX = 500;
const BANK_ADDRESS_MAX = 500;

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

  const [currencyCode, setCurrencyCode] = useState(initialValues.currency_code);
  const [legalNameTh, setLegalNameTh] = useState(initialValues.legal_name_th);
  const [legalNameEn, setLegalNameEn] = useState(initialValues.legal_name_en);
  const [taxId, setTaxId] = useState(initialValues.tax_id);
  const [addrTh, setAddrTh] = useState(initialValues.registered_address_th);
  const [addrEn, setAddrEn] = useState(initialValues.registered_address_en);
  const [vatPercent, setVatPercent] = useState(initialValues.vat_percent);
  const [regFee, setRegFee] = useState(initialValues.registration_fee_baht);
  const [invoicePrefix, setInvoicePrefix] = useState(initialValues.invoice_number_prefix);
  const [creditPrefix, setCreditPrefix] = useState(initialValues.credit_note_number_prefix);
  // 088 US5 (T043 / F.5) — combined mode is RETIRED. The numbering mode is now
  // ALWAYS 'separate' (the §86/4 receipt gets its own §87 stream), so this is a
  // constant, rendered read-only below. Any legacy stored 'combined' is ignored.
  const receiptMode = 'separate' as const;
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

  // 088 US5 (T043) — seller §86/4 branch.
  const [sellerIsHeadOffice, setSellerIsHeadOffice] = useState(
    initialValues.seller_is_head_office,
  );
  const [sellerBranchCode, setSellerBranchCode] = useState(
    initialValues.seller_branch_code ?? '',
  );
  // 088 US5 (T043) — WHT footer note.
  const [whtNoteTh, setWhtNoteTh] = useState(initialValues.wht_note_th ?? '');
  const [whtNoteEn, setWhtNoteEn] = useState(initialValues.wht_note_en ?? '');
  // 088 US5 (T043b) — offline-payment bank block.
  const [bankPayeeName, setBankPayeeName] = useState(initialValues.bank_payee_name ?? '');
  const [bankAccountNo, setBankAccountNo] = useState(initialValues.bank_account_no ?? '');
  const [bankAccountType, setBankAccountType] = useState(
    initialValues.bank_account_type ?? '',
  );
  const [bankName, setBankName] = useState(initialValues.bank_name ?? '');
  const [bankBranch, setBankBranch] = useState(initialValues.bank_branch ?? '');
  const [bankAddress, setBankAddress] = useState(initialValues.bank_address ?? '');
  const [bankSwift, setBankSwift] = useState(initialValues.bank_swift ?? '');
  const [paymentInstructionsTh, setPaymentInstructionsTh] = useState(
    initialValues.payment_instructions_th ?? '',
  );
  const [paymentInstructionsEn, setPaymentInstructionsEn] = useState(
    initialValues.payment_instructions_en ?? '',
  );

  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 088 US5 (T043a) — prefix-change confirmation. When a document-number prefix
  // changes on an existing tenant, hold the validated body until the admin
  // confirms the §87 numbering-stream impact.
  const [pendingBody, setPendingBody] = useState<Record<string, unknown> | null>(null);

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

    // ISO 4217 client-side sanity check — the DB CHECK + Application
    // regex are the real guards; this just catches obvious typos fast.
    const normalisedCurrency = currencyCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalisedCurrency)) {
      setError(t('errors.currencyCode'));
      setSubmitting(false);
      return;
    }

    // 088 US5 (T043b) — seller §86/4 branch pairing + bank-field format guards.
    // Mirror the route zod / DB CHECK so the admin gets fast inline feedback.
    const branchTrimmed = sellerBranchCode.trim();
    if (!sellerIsHeadOffice && !BRANCH_CODE_RE.test(branchTrimmed)) {
      setError(t('errors.sellerBranch'));
      setSubmitting(false);
      return;
    }
    const swiftTrimmed = bankSwift.trim().toUpperCase();
    if (swiftTrimmed !== '' && !SWIFT_RE.test(swiftTrimmed)) {
      setError(t('errors.bankSwift'));
      setSubmitting(false);
      return;
    }
    const accountTrimmed = bankAccountNo.trim();
    if (accountTrimmed !== '' && !ACCOUNT_NO_RE.test(accountTrimmed)) {
      setError(t('errors.bankAccountNo'));
      setSubmitting(false);
      return;
    }

    // Optional free-text → null when blank so a cleared field clears the column.
    const orNull = (v: string) => (v.trim() === '' ? null : v.trim());
    const receiptPrefixValue = receiptPrefix.trim() === '' ? null : receiptPrefix;

    // 088 US7 (review fix) — 'RE' is reserved for the §105 event-receipt
    // register (hardcoded prefix). A §86/4 receipt prefix of 'RE' would collide
    // with it on the shared receipt-number unique index. Reject early with a
    // localized message (the route zod is the real boundary; this mirrors it for
    // fast inline feedback). Case-insensitive — document prefixes are uppercase.
    if (receiptPrefixValue !== null && receiptPrefixValue.trim().toUpperCase() === 'RE') {
      setError(t('errors.receiptPrefixReserved'));
      setSubmitting(false);
      return;
    }

    const body = {
      currency_code: normalisedCurrency,
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
      receipt_number_prefix: receiptPrefixValue,
      fiscal_year_start_month: fiscalMonth,
      default_net_days: netDays,
      pro_rate_policy: proRate,
      auto_email_enabled: autoEmail,
      ...(logoBlobKey !== null && { logo_blob_key: logoBlobKey }),
      // 088 US5 (T043) — seller branch + WHT note + bank block.
      seller_is_head_office: sellerIsHeadOffice,
      seller_branch_code: sellerIsHeadOffice ? null : branchTrimmed,
      wht_note_th: orNull(whtNoteTh),
      wht_note_en: orNull(whtNoteEn),
      bank_payee_name: orNull(bankPayeeName),
      bank_account_no: accountTrimmed === '' ? null : accountTrimmed,
      bank_account_type: orNull(bankAccountType),
      bank_name: orNull(bankName),
      bank_branch: orNull(bankBranch),
      bank_address: orNull(bankAddress),
      bank_swift: swiftTrimmed === '' ? null : swiftTrimmed,
      payment_instructions_th: orNull(paymentInstructionsTh),
      payment_instructions_en: orNull(paymentInstructionsEn),
    };

    // 088 US5 (T043a / FR-026) — a document-number prefix flip on an existing
    // tenant starts a NEW §87 numbering stream. Confirm before saving so the
    // admin acknowledges the impact. First-time bootstrap (no prior row) skips
    // the dialog — there is no stream to disrupt yet.
    const prefixChanged =
      exists &&
      (invoicePrefix !== initialValues.invoice_number_prefix ||
        creditPrefix !== initialValues.credit_note_number_prefix ||
        receiptPrefixValue !== (initialValues.receipt_number_prefix ?? null));

    if (prefixChanged) {
      setPendingBody(body);
      setSubmitting(false);
      return;
    }

    await doPatch(body);
  }

  async function doPatch(body: Record<string, unknown>) {
    setSubmitting(true);
    setError(null);
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
      else {
        setError(t('errors.generic'));
        toast.error(t('errors.generic'));
      }
    } catch {
      setError(t('errors.generic'));
      toast.error(t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      // method="post" — CWE-598; see tests/unit/components/pii-forms-post-method.test.tsx
      method="post"
      className="flex flex-col gap-[var(--page-section-gap)]"
      noValidate
    >
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
            onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())}
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
      </fieldset>

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
      </fieldset>

      {/* Numbering */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">
          {t('sections.numbering')}
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="inv_prefix">{t('labels.invoicePrefix')}</Label>
            <Input
              id="inv_prefix"
              className="min-h-11"
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
              className="min-h-11"
              value={creditPrefix}
              onChange={(e) => setCreditPrefix(e.target.value)}
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
              onChange={(e) => setReceiptPrefix(e.target.value)}
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

      {/* Defaults */}
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
      </fieldset>

      {/* 088 US5 — Seller §86/4 Head-Office / Branch */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">{t('sections.seller')}</legend>
        {/* T072b (FR-036) — gap-3 + min-w-0 keep this new row from overflowing
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
            checked={sellerIsHeadOffice}
            onCheckedChange={setSellerIsHeadOffice}
            disabled={disabled}
          />
        </div>
        {!sellerIsHeadOffice ? (
          <div className="space-y-2 sm:max-w-xs">
            <Label htmlFor="seller_branch">{t('labels.sellerBranchCode')}</Label>
            <Input
              id="seller_branch"
              value={sellerBranchCode}
              onChange={(e) => setSellerBranchCode(e.target.value)}
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

      {/* 088 US5 — Withholding-tax footer note (membership documents only) */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">{t('sections.whtNote')}</legend>
        <p className="text-xs text-muted-foreground">{t('hints.whtNote')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="wht_th">{t('labels.whtNoteTh')}</Label>
            <Textarea
              id="wht_th"
              value={whtNoteTh}
              onChange={(e) => setWhtNoteTh(e.target.value)}
              disabled={disabled}
              maxLength={WHT_MAX}
              rows={3}
              lang="th"
              // 088 US5 — RD-validated suggested wording (membership dues are
              // WHT-exempt, §65 bis (13) / ruling กค 0811/8542). Placeholder, not
              // a forced value: the admin still opts in per tenant.
              placeholder={t('hints.whtNoteThExample')}
            />
            <p className="text-right text-xs text-muted-foreground">
              {t('charCount', { count: whtNoteTh.length, max: WHT_MAX })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wht_en">{t('labels.whtNoteEn')}</Label>
            <Textarea
              id="wht_en"
              value={whtNoteEn}
              onChange={(e) => setWhtNoteEn(e.target.value)}
              disabled={disabled}
              maxLength={WHT_MAX}
              rows={3}
              placeholder={t('hints.whtNoteEnExample')}
            />
            <p className="text-right text-xs text-muted-foreground">
              {t('charCount', { count: whtNoteEn.length, max: WHT_MAX })}
            </p>
          </div>
        </div>
      </fieldset>

      {/* 088 US5 — Offline-payment bank block (ใบแจ้งหนี้ / bill only) */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">{t('sections.bank')}</legend>
        <p className="text-xs text-muted-foreground">{t('hints.bank')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="bank_payee">{t('labels.bankPayeeName')}</Label>
            <Input
              id="bank_payee"
              value={bankPayeeName}
              onChange={(e) => setBankPayeeName(e.target.value)}
              disabled={disabled}
              maxLength={200}
              // T072b (FR-036) — ≥44px touch target (new US5 bank-block input).
              className="min-h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bank_name">{t('labels.bankName')}</Label>
            <Input
              id="bank_name"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              disabled={disabled}
              maxLength={200}
              className="min-h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bank_account_no">{t('labels.bankAccountNo')}</Label>
            <Input
              id="bank_account_no"
              value={bankAccountNo}
              onChange={(e) => setBankAccountNo(e.target.value)}
              disabled={disabled}
              inputMode="numeric"
              maxLength={50}
              aria-describedby="bank_account_no_hint"
              className="min-h-11 font-mono"
            />
            <p id="bank_account_no_hint" className="text-xs text-muted-foreground">
              {t('hints.bankAccountNo')}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bank_account_type">{t('labels.bankAccountType')}</Label>
            <Input
              id="bank_account_type"
              value={bankAccountType}
              onChange={(e) => setBankAccountType(e.target.value)}
              disabled={disabled}
              maxLength={50}
              className="min-h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bank_branch">{t('labels.bankBranch')}</Label>
            <Input
              id="bank_branch"
              value={bankBranch}
              onChange={(e) => setBankBranch(e.target.value)}
              disabled={disabled}
              maxLength={200}
              className="min-h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bank_swift">{t('labels.bankSwift')}</Label>
            <Input
              id="bank_swift"
              value={bankSwift}
              onChange={(e) => setBankSwift(e.target.value.toUpperCase())}
              disabled={disabled}
              maxLength={11}
              // 088 T061g — SWIFT/BIC character hint (belt + braces with the
              // SWIFT_RE guard on submit); 8 or 11 alphanumerics, uppercase.
              inputMode="text"
              pattern="[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?"
              aria-describedby="bank_swift_hint"
              className="min-h-11 font-mono uppercase"
            />
            <p id="bank_swift_hint" className="text-xs text-muted-foreground">
              {t('hints.bankSwift')}
            </p>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="bank_address">{t('labels.bankAddress')}</Label>
            <Textarea
              id="bank_address"
              value={bankAddress}
              onChange={(e) => setBankAddress(e.target.value)}
              disabled={disabled}
              maxLength={BANK_ADDRESS_MAX}
              rows={2}
            />
            <p className="text-right text-xs text-muted-foreground">
              {t('charCount', { count: bankAddress.length, max: BANK_ADDRESS_MAX })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pay_instr_th">{t('labels.paymentInstructionsTh')}</Label>
            <Textarea
              id="pay_instr_th"
              value={paymentInstructionsTh}
              onChange={(e) => setPaymentInstructionsTh(e.target.value)}
              disabled={disabled}
              maxLength={INSTRUCTIONS_MAX}
              rows={2}
              lang="th"
            />
            <p className="text-right text-xs text-muted-foreground">
              {t('charCount', { count: paymentInstructionsTh.length, max: INSTRUCTIONS_MAX })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pay_instr_en">{t('labels.paymentInstructionsEn')}</Label>
            <Textarea
              id="pay_instr_en"
              value={paymentInstructionsEn}
              onChange={(e) => setPaymentInstructionsEn(e.target.value)}
              disabled={disabled}
              maxLength={INSTRUCTIONS_MAX}
              rows={2}
            />
            <p className="text-right text-xs text-muted-foreground">
              {t('charCount', { count: paymentInstructionsEn.length, max: INSTRUCTIONS_MAX })}
            </p>
          </div>
        </div>
      </fieldset>

      {/* Logo */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">
          {t('sections.logo')}
        </legend>
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
      </fieldset>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {isAdmin ? (
        <Button
          type="submit"
          size="lg"
          // T072b (FR-036) — the primary Save is the key mobile action: ≥44px
          // tall + full-width so it stays a reachable tap target at 320px.
          className="min-h-11 w-full"
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting && (
            <Loader2Icon className="mr-2 h-4 w-4 motion-safe:animate-spin" aria-hidden />
          )}
          {submitting
            ? t('saving')
            : exists
              ? t('actions.save')
              : t('actions.create')}
        </Button>
      ) : null}

      {/* 088 US5 (T043a / FR-026) — confirm a document-number prefix flip before
          it starts a new §87 numbering stream. */}
      <AlertDialog
        open={pendingBody !== null}
        onOpenChange={(next) => {
          if (!next) setPendingBody(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('prefixChange.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('prefixChange.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingBody(null)}>
              {t('prefixChange.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const body = pendingBody;
                setPendingBody(null);
                if (body) void doPatch(body);
              }}
            >
              {t('prefixChange.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
