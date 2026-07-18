/**
 * R7-B2 — InvoiceSettingsForm (F4 US4 / FR-009 / FR-034).
 *
 * Task 7 (settings-ux-invoice-reminders) — this is now a thin
 * orchestrator over the two-column sticky-nav shell: `SectionNav` (left
 * rail) + the six presentational `<*Section>` components (Task 6) for
 * the field JSX, plus `StickySaveBar` (Task 3) for a persistently
 * reachable Save once the form is dirty. ALL field state, `handleSubmit`
 * (validation + the PATCH body-building object), `doPatch`, and the
 * prefix-change `AlertDialog` are unchanged from the pre-refactor flat
 * form — only the JSX that RENDERS the fields moved into the section
 * components (mechanical extraction, Task 6). The sticky bar's Save
 * button never calls `fetch` itself: it drives `formRef.current
 * ?.requestSubmit()`, which re-enters this same `handleSubmit`, so every
 * validation guard below (prefix-change confirm, reserved 'RE' receipt
 * prefix, seller branch pairing, VAT range, SWIFT/account format,
 * ISO-4217 currency) fires identically regardless of which Save was
 * clicked.
 *
 * Original section map (F4 US4 / FR-009 / FR-034):
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

import { useRef, useState } from 'react';
import { Loader2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { isDirty } from '@/components/invoices/invoice-settings/form-dirty';
import { useUnsavedGuard } from '@/components/invoices/invoice-settings/use-unsaved-guard';
import {
  SectionNav,
  type SectionNavItem,
} from '@/components/invoices/invoice-settings/section-nav';
import { StickySaveBar } from '@/components/invoices/invoice-settings/sticky-save-bar';
import { OrganizationSection } from '@/components/invoices/invoice-settings/sections/organization-section';
import { TaxVatSection } from '@/components/invoices/invoice-settings/sections/tax-vat-section';
import { NumberingSection } from '@/components/invoices/invoice-settings/sections/numbering-section';
import { DocumentNotesSection } from '@/components/invoices/invoice-settings/sections/document-notes-section';
import { PaymentSection } from '@/components/invoices/invoice-settings/sections/payment-section';
import { BrandingSection } from '@/components/invoices/invoice-settings/sections/branding-section';

export interface InvoiceSettingsFormInitialValues {
  readonly currency_code: string; // ISO 4217 (e.g. "THB")
  readonly legal_name_th: string;
  readonly legal_name_en: string;
  /** 064 — tenant short/brand name (e.g. "SweCham"); '' = unset. */
  readonly brand_name: string;
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
  // 065 §5.4 — statutory termination notice (bill-only render).
  readonly termination_notice_th: string | null;
  readonly termination_notice_en: string | null;
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

// Task 7 — two-column sticky-nav section map (spec §4.3). Module-scope so
// the array reference is stable across renders: `SectionNav` memoises its
// derived `sectionIds` on this reference, and a fresh array every render
// would tear down + rebuild its IntersectionObserver on every keystroke.
const SECTIONS: ReadonlyArray<SectionNavItem> = [
  { id: 'organization', labelKey: 'sections.organization' },
  { id: 'tax', labelKey: 'sections.tax' },
  { id: 'numbering', labelKey: 'sections.numbering' },
  { id: 'notes', labelKey: 'sections.documentNotes' },
  { id: 'payment', labelKey: 'sections.payment' },
  { id: 'branding', labelKey: 'sections.branding' },
];

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
  const formRef = useRef<HTMLFormElement>(null);

  const [currencyCode, setCurrencyCode] = useState(initialValues.currency_code);
  const [legalNameTh, setLegalNameTh] = useState(initialValues.legal_name_th);
  const [legalNameEn, setLegalNameEn] = useState(initialValues.legal_name_en);
  const [brandName, setBrandName] = useState(initialValues.brand_name);
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
  // 065 §5.4 — statutory termination notice (bill-only render).
  const [terminationNoticeTh, setTerminationNoticeTh] = useState(
    initialValues.termination_notice_th ?? '',
  );
  const [terminationNoticeEn, setTerminationNoticeEn] = useState(
    initialValues.termination_notice_en ?? '',
  );
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

  // Task 7 (spec §4.4) — dirty-state comparison feeding the sticky Save
  // bar + the beforeunload guard. Same flat key set on both sides so
  // `isDirty` does a straight per-key `Object.is` diff.
  const initialRecord: Record<string, unknown> = {
    currency_code: initialValues.currency_code,
    legal_name_th: initialValues.legal_name_th,
    legal_name_en: initialValues.legal_name_en,
    brand_name: initialValues.brand_name,
    tax_id: initialValues.tax_id,
    registered_address_th: initialValues.registered_address_th,
    registered_address_en: initialValues.registered_address_en,
    vat_percent: initialValues.vat_percent,
    registration_fee_baht: initialValues.registration_fee_baht,
    invoice_number_prefix: initialValues.invoice_number_prefix,
    credit_note_number_prefix: initialValues.credit_note_number_prefix,
    receipt_number_prefix: initialValues.receipt_number_prefix ?? '',
    fiscal_year_start_month: String(initialValues.fiscal_year_start_month),
    default_net_days: String(initialValues.default_net_days),
    pro_rate_policy: initialValues.pro_rate_policy,
    auto_email_enabled: initialValues.auto_email_enabled,
    logo_blob_key: initialValues.logo_blob_key,
    seller_is_head_office: initialValues.seller_is_head_office,
    seller_branch_code: initialValues.seller_branch_code ?? '',
    wht_note_th: initialValues.wht_note_th ?? '',
    wht_note_en: initialValues.wht_note_en ?? '',
    termination_notice_th: initialValues.termination_notice_th ?? '',
    termination_notice_en: initialValues.termination_notice_en ?? '',
    bank_payee_name: initialValues.bank_payee_name ?? '',
    bank_account_no: initialValues.bank_account_no ?? '',
    bank_account_type: initialValues.bank_account_type ?? '',
    bank_name: initialValues.bank_name ?? '',
    bank_branch: initialValues.bank_branch ?? '',
    bank_address: initialValues.bank_address ?? '',
    bank_swift: initialValues.bank_swift ?? '',
    payment_instructions_th: initialValues.payment_instructions_th ?? '',
    payment_instructions_en: initialValues.payment_instructions_en ?? '',
  };
  const currentValues: Record<string, unknown> = {
    currency_code: currencyCode,
    legal_name_th: legalNameTh,
    legal_name_en: legalNameEn,
    brand_name: brandName,
    tax_id: taxId,
    registered_address_th: addrTh,
    registered_address_en: addrEn,
    vat_percent: vatPercent,
    registration_fee_baht: regFee,
    invoice_number_prefix: invoicePrefix,
    credit_note_number_prefix: creditPrefix,
    receipt_number_prefix: receiptPrefix,
    fiscal_year_start_month: fiscalStartMonth,
    default_net_days: defaultNetDays,
    pro_rate_policy: proRate,
    auto_email_enabled: autoEmail,
    logo_blob_key: logoBlobKey,
    seller_is_head_office: sellerIsHeadOffice,
    seller_branch_code: sellerBranchCode,
    wht_note_th: whtNoteTh,
    wht_note_en: whtNoteEn,
    termination_notice_th: terminationNoticeTh,
    termination_notice_en: terminationNoticeEn,
    bank_payee_name: bankPayeeName,
    bank_account_no: bankAccountNo,
    bank_account_type: bankAccountType,
    bank_name: bankName,
    bank_branch: bankBranch,
    bank_address: bankAddress,
    bank_swift: bankSwift,
    payment_instructions_th: paymentInstructionsTh,
    payment_instructions_en: paymentInstructionsEn,
  };
  const dirty = isAdmin && isDirty(initialRecord, currentValues);
  useUnsavedGuard(dirty);

  // Task 7 (spec §6.3) — a blocked (validation-failed) submit focuses the
  // first invalid field so keyboard/screen-reader users land where the
  // error is, instead of only reading the top-of-form `role="alert"`.
  // Most guards below already have a matching native HTML constraint
  // (required/pattern/min/max) on their input, so the browser's own
  // `:invalid` state finds them with no extra bookkeeping. The two guards
  // with no native equivalent (bank account-number format, reserved 'RE'
  // receipt prefix) are marked imperatively via `aria-invalid` — a direct
  // DOM write (not React state) so the marker is visible to this
  // synchronous query immediately, without waiting for a re-render.
  function markInvalid(fieldId: string) {
    formRef.current?.querySelector<HTMLElement>(`#${fieldId}`)?.setAttribute('aria-invalid', 'true');
  }
  function focusFirstInvalidField() {
    const target = formRef.current?.querySelector<HTMLElement>(':invalid, [aria-invalid="true"]');
    target?.focus();
    target?.scrollIntoView?.({ block: 'center' });
  }

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
    // Clear markers left by a previous blocked submit (see markInvalid
    // above) so a fixed field doesn't stay flagged forever.
    formRef.current
      ?.querySelectorAll<HTMLElement>('[aria-invalid="true"]')
      .forEach((el) => el.removeAttribute('aria-invalid'));

    // Percent → 4-dp decimal string. Guard against Number.parseFloat
    // returning NaN on empty input.
    const vatNum = Number.parseFloat(vatPercent);
    if (Number.isNaN(vatNum) || vatNum < 0 || vatNum > 30) {
      setError(t('errors.vatRange'));
      setSubmitting(false);
      focusFirstInvalidField();
      return;
    }
    const vatDecimalString = (vatNum / 100).toFixed(4);

    // Major units → satang (bigint serialised as string).
    const regFeeMajor = Number.parseFloat(regFee);
    if (Number.isNaN(regFeeMajor) || regFeeMajor < 0) {
      setError(t('errors.regFeeRange'));
      setSubmitting(false);
      focusFirstInvalidField();
      return;
    }
    const regFeeSatang = String(Math.round(regFeeMajor * 100));

    const fiscalMonth = Number.parseInt(fiscalStartMonth, 10);
    const netDays = Number.parseInt(defaultNetDays, 10);
    if (Number.isNaN(fiscalMonth) || fiscalMonth < 1 || fiscalMonth > 12) {
      setError(t('errors.fiscalMonth'));
      setSubmitting(false);
      focusFirstInvalidField();
      return;
    }
    if (Number.isNaN(netDays) || netDays < 0 || netDays > 365) {
      setError(t('errors.netDays'));
      setSubmitting(false);
      focusFirstInvalidField();
      return;
    }

    // ISO 4217 client-side sanity check — the DB CHECK + Application
    // regex are the real guards; this just catches obvious typos fast.
    const normalisedCurrency = currencyCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalisedCurrency)) {
      setError(t('errors.currencyCode'));
      setSubmitting(false);
      focusFirstInvalidField();
      return;
    }

    // 088 US5 (T043b) — seller §86/4 branch pairing + bank-field format guards.
    // Mirror the route zod / DB CHECK so the admin gets fast inline feedback.
    const branchTrimmed = sellerBranchCode.trim();
    if (!sellerIsHeadOffice && !BRANCH_CODE_RE.test(branchTrimmed)) {
      setError(t('errors.sellerBranch'));
      setSubmitting(false);
      focusFirstInvalidField();
      return;
    }
    const swiftTrimmed = bankSwift.trim().toUpperCase();
    if (swiftTrimmed !== '' && !SWIFT_RE.test(swiftTrimmed)) {
      setError(t('errors.bankSwift'));
      setSubmitting(false);
      focusFirstInvalidField();
      return;
    }
    const accountTrimmed = bankAccountNo.trim();
    if (accountTrimmed !== '' && !ACCOUNT_NO_RE.test(accountTrimmed)) {
      // bank_account_no has no native `pattern` constraint (free-format,
      // optional field) — mark it explicitly so focusFirstInvalidField finds it.
      markInvalid('bank_account_no');
      setError(t('errors.bankAccountNo'));
      setSubmitting(false);
      focusFirstInvalidField();
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
      // No native constraint expresses "not equal to a reserved value" —
      // mark it explicitly so focusFirstInvalidField finds it.
      markInvalid('rc_prefix');
      setError(t('errors.receiptPrefixReserved'));
      setSubmitting(false);
      focusFirstInvalidField();
      return;
    }

    const body = {
      currency_code: normalisedCurrency,
      legal_name_th: legalNameTh,
      legal_name_en: legalNameEn,
      // 064 — empty clears it (→ membership-line prefix omitted).
      brand_name: brandName.trim() === '' ? null : brandName.trim(),
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
      // 065 §5.4 — statutory termination notice.
      termination_notice_th: orNull(terminationNoticeTh),
      termination_notice_en: orNull(terminationNoticeEn),
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
      ref={formRef}
      onSubmit={handleSubmit}
      // method="post" — CWE-598; see tests/unit/components/pii-forms-post-method.test.tsx
      method="post"
      className="flex flex-col gap-[var(--page-section-gap)] md:flex-row md:items-start md:gap-8"
      noValidate
    >
      <SectionNav sections={SECTIONS} />

      <div className="flex min-w-0 flex-1 flex-col gap-[var(--page-section-gap)]">
        <OrganizationSection
          currencyCode={currencyCode}
          onCurrencyCodeChange={setCurrencyCode}
          legalNameTh={legalNameTh}
          onLegalNameThChange={setLegalNameTh}
          legalNameEn={legalNameEn}
          onLegalNameEnChange={setLegalNameEn}
          brandName={brandName}
          onBrandNameChange={setBrandName}
          taxId={taxId}
          onTaxIdChange={setTaxId}
          addrTh={addrTh}
          onAddrThChange={setAddrTh}
          addrEn={addrEn}
          onAddrEnChange={setAddrEn}
          sellerIsHeadOffice={sellerIsHeadOffice}
          onSellerIsHeadOfficeChange={setSellerIsHeadOffice}
          sellerBranchCode={sellerBranchCode}
          onSellerBranchCodeChange={setSellerBranchCode}
          disabled={disabled}
        />

        <TaxVatSection
          vatPercent={vatPercent}
          onVatPercentChange={setVatPercent}
          regFee={regFee}
          onRegFeeChange={setRegFee}
          disabled={disabled}
        />

        <NumberingSection
          invoicePrefix={invoicePrefix}
          onInvoicePrefixChange={setInvoicePrefix}
          creditPrefix={creditPrefix}
          onCreditPrefixChange={setCreditPrefix}
          receiptPrefix={receiptPrefix}
          onReceiptPrefixChange={setReceiptPrefix}
          fiscalStartMonth={fiscalStartMonth}
          onFiscalStartMonthChange={setFiscalStartMonth}
          defaultNetDays={defaultNetDays}
          onDefaultNetDaysChange={setDefaultNetDays}
          proRate={proRate}
          onProRateChange={setProRate}
          disabled={disabled}
        />

        <DocumentNotesSection
          whtNoteTh={whtNoteTh}
          onWhtNoteThChange={setWhtNoteTh}
          whtNoteEn={whtNoteEn}
          onWhtNoteEnChange={setWhtNoteEn}
          terminationNoticeTh={terminationNoticeTh}
          onTerminationNoticeThChange={setTerminationNoticeTh}
          terminationNoticeEn={terminationNoticeEn}
          onTerminationNoticeEnChange={setTerminationNoticeEn}
          autoEmail={autoEmail}
          onAutoEmailChange={setAutoEmail}
          disabled={disabled}
        />

        <PaymentSection
          bankPayeeName={bankPayeeName}
          onBankPayeeNameChange={setBankPayeeName}
          bankName={bankName}
          onBankNameChange={setBankName}
          bankAccountNo={bankAccountNo}
          onBankAccountNoChange={setBankAccountNo}
          bankAccountType={bankAccountType}
          onBankAccountTypeChange={setBankAccountType}
          bankBranch={bankBranch}
          onBankBranchChange={setBankBranch}
          bankSwift={bankSwift}
          onBankSwiftChange={setBankSwift}
          bankAddress={bankAddress}
          onBankAddressChange={setBankAddress}
          paymentInstructionsTh={paymentInstructionsTh}
          onPaymentInstructionsThChange={setPaymentInstructionsTh}
          paymentInstructionsEn={paymentInstructionsEn}
          onPaymentInstructionsEnChange={setPaymentInstructionsEn}
          disabled={disabled}
        />

        <BrandingSection
          logoBlobKey={logoBlobKey}
          uploadingLogo={uploadingLogo}
          logoError={logoError}
          onLogoChange={handleLogoChange}
          disabled={disabled}
        />

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
      </div>

      <StickySaveBar
        visible={dirty}
        submitting={submitting}
        onSave={() => formRef.current?.requestSubmit()}
      />

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
