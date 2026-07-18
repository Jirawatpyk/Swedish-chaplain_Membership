/**
 * Task 6 — "Payment" settings section (offline bank-transfer block +
 * payment instructions).
 *
 * Mechanical extraction from `invoice-settings-form.tsx`'s Bank
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
import { Textarea } from '@/components/ui/textarea';

const INSTRUCTIONS_MAX = 500;
const BANK_ADDRESS_MAX = 500;

export interface PaymentSectionProps {
  readonly bankPayeeName: string;
  readonly onBankPayeeNameChange: (value: string) => void;
  readonly bankName: string;
  readonly onBankNameChange: (value: string) => void;
  readonly bankAccountNo: string;
  readonly onBankAccountNoChange: (value: string) => void;
  readonly bankAccountType: string;
  readonly onBankAccountTypeChange: (value: string) => void;
  readonly bankBranch: string;
  readonly onBankBranchChange: (value: string) => void;
  readonly bankSwift: string;
  readonly onBankSwiftChange: (value: string) => void;
  readonly bankAddress: string;
  readonly onBankAddressChange: (value: string) => void;
  readonly paymentInstructionsTh: string;
  readonly onPaymentInstructionsThChange: (value: string) => void;
  readonly paymentInstructionsEn: string;
  readonly onPaymentInstructionsEnChange: (value: string) => void;
  readonly disabled: boolean;
}

export function PaymentSection({
  bankPayeeName,
  onBankPayeeNameChange,
  bankName,
  onBankNameChange,
  bankAccountNo,
  onBankAccountNoChange,
  bankAccountType,
  onBankAccountTypeChange,
  bankBranch,
  onBankBranchChange,
  bankSwift,
  onBankSwiftChange,
  bankAddress,
  onBankAddressChange,
  paymentInstructionsTh,
  onPaymentInstructionsThChange,
  paymentInstructionsEn,
  onPaymentInstructionsEnChange,
  disabled,
}: PaymentSectionProps) {
  const t = useTranslations('admin.invoiceSettings');

  return (
    <section
      id="payment"
      aria-labelledby="payment-heading"
      className="flex flex-col gap-[var(--page-section-gap)]"
    >
      <h2
        id="payment-heading"
        data-section-heading
        tabIndex={-1}
        className="font-heading text-base font-semibold"
      >
        {t('sections.payment')}
      </h2>

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
              onChange={(e) => onBankPayeeNameChange(e.target.value)}
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
              onChange={(e) => onBankNameChange(e.target.value)}
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
              onChange={(e) => onBankAccountNoChange(e.target.value)}
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
              onChange={(e) => onBankAccountTypeChange(e.target.value)}
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
              onChange={(e) => onBankBranchChange(e.target.value)}
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
              onChange={(e) => onBankSwiftChange(e.target.value.toUpperCase())}
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
              onChange={(e) => onBankAddressChange(e.target.value)}
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
              onChange={(e) => onPaymentInstructionsThChange(e.target.value)}
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
              onChange={(e) => onPaymentInstructionsEnChange(e.target.value)}
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
    </section>
  );
}
