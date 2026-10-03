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
 *
 * Spec 122 US8c-2 (T856) — an AURA card (board `Admin-invoice-settings`),
 * the rail's focus target, with AURA fields; ids, labels, hints, limits and
 * character counters (now each field's hint) unchanged. The six bank text
 * fields keep their 44px boxes (088 FR-036, `touchHeight="always"`).
 */
'use client';

import { useTranslations } from 'next-intl';
import { Card, TextField, Textarea } from '@jirawatpyk/aura-react';

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
    <Card
      as="section"
      id="payment"
      tabIndex={-1}
      className="scroll-mt-24 focus-visible:outline-none"
      title={t('sections.payment')}
      titleId="payment-heading"
      headingLevel={2}
    >
      {/* 088 US5 — Offline-payment bank block (ใบแจ้งหนี้ / bill only) */}
      <fieldset className="flex flex-col gap-[var(--aura-space-3)]">
        <legend className="mb-[var(--aura-space-1)] text-sm font-semibold">{t('sections.bank')}</legend>
        <p className="text-sm text-[var(--aura-fg-secondary)]">{t('hints.bank')}</p>
        <div className="grid grid-cols-1 gap-[var(--aura-space-4)] sm:grid-cols-2">
          <TextField
            id="bank_payee"
            label={t('labels.bankPayeeName')}
            value={bankPayeeName}
            onChange={(e) => onBankPayeeNameChange(e.target.value)}
            disabled={disabled}
            maxLength={200}
            // T072b (FR-036) — ≥44px touch target at every width.
            touchHeight="always"
          />
          <TextField
            id="bank_name"
            label={t('labels.bankName')}
            value={bankName}
            onChange={(e) => onBankNameChange(e.target.value)}
            disabled={disabled}
            maxLength={200}
            touchHeight="always"
          />
          <TextField
            id="bank_account_no"
            label={t('labels.bankAccountNo')}
            hint={t('hints.bankAccountNo')}
            value={bankAccountNo}
            onChange={(e) => onBankAccountNoChange(e.target.value)}
            disabled={disabled}
            inputMode="numeric"
            maxLength={50}
            touchHeight="always"
            className="[&_input]:font-mono"
          />
          <TextField
            id="bank_account_type"
            label={t('labels.bankAccountType')}
            value={bankAccountType}
            onChange={(e) => onBankAccountTypeChange(e.target.value)}
            disabled={disabled}
            maxLength={50}
            touchHeight="always"
          />
          <TextField
            id="bank_branch"
            label={t('labels.bankBranch')}
            value={bankBranch}
            onChange={(e) => onBankBranchChange(e.target.value)}
            disabled={disabled}
            maxLength={200}
            touchHeight="always"
          />
          <TextField
            id="bank_swift"
            label={t('labels.bankSwift')}
            hint={t('hints.bankSwift')}
            value={bankSwift}
            onChange={(e) => onBankSwiftChange(e.target.value.toUpperCase())}
            disabled={disabled}
            maxLength={11}
            // 088 T061g — SWIFT/BIC character hint (belt + braces with the
            // SWIFT_RE guard on submit); 8 or 11 alphanumerics, uppercase.
            inputMode="text"
            pattern="[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?"
            touchHeight="always"
            className="[&_input]:font-mono [&_input]:uppercase"
          />
          <Textarea
            id="bank_address"
            label={t('labels.bankAddress')}
            hint={t('charCount', { count: bankAddress.length, max: BANK_ADDRESS_MAX })}
            value={bankAddress}
            onChange={(e) => onBankAddressChange(e.target.value)}
            disabled={disabled}
            maxLength={BANK_ADDRESS_MAX}
            rows={2}
            className="sm:col-span-2"
          />
          <Textarea
            id="pay_instr_th"
            label={t('labels.paymentInstructionsTh')}
            hint={t('charCount', { count: paymentInstructionsTh.length, max: INSTRUCTIONS_MAX })}
            value={paymentInstructionsTh}
            onChange={(e) => onPaymentInstructionsThChange(e.target.value)}
            disabled={disabled}
            maxLength={INSTRUCTIONS_MAX}
            rows={2}
            lang="th"
          />
          <Textarea
            id="pay_instr_en"
            label={t('labels.paymentInstructionsEn')}
            hint={t('charCount', { count: paymentInstructionsEn.length, max: INSTRUCTIONS_MAX })}
            value={paymentInstructionsEn}
            onChange={(e) => onPaymentInstructionsEnChange(e.target.value)}
            disabled={disabled}
            maxLength={INSTRUCTIONS_MAX}
            rows={2}
          />
        </div>
      </fieldset>
    </Card>
  );
}
