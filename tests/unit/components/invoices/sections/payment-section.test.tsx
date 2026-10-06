import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  PaymentSection,
  type PaymentSectionProps,
} from '@/components/invoices/invoice-settings/sections/payment-section';

const BASE_PROPS: PaymentSectionProps = {
  bankPayeeName: '',
  onBankPayeeNameChange: vi.fn(),
  bankName: '',
  onBankNameChange: vi.fn(),
  bankAccountNo: '',
  onBankAccountNoChange: vi.fn(),
  bankAccountType: '',
  onBankAccountTypeChange: vi.fn(),
  bankBranch: '',
  onBankBranchChange: vi.fn(),
  bankSwift: '',
  onBankSwiftChange: vi.fn(),
  bankAddress: '',
  onBankAddressChange: vi.fn(),
  paymentInstructionsTh: '',
  onPaymentInstructionsThChange: vi.fn(),
  paymentInstructionsEn: '',
  onPaymentInstructionsEnChange: vi.fn(),
  disabled: false,
};

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

// Spec 122 US8c-2 (T856) — each section is an AURA card, focusable (the rail
// moves focus to it) and labelled by its h2.
it('renders the section as an AURA card labelled by its h2, the rail\'s focus target', () => {
  wrap(<PaymentSection {...BASE_PROPS} />);
  const section = document.getElementById('payment');
  expect(section).not.toBeNull();
  expect(section).toHaveClass('aura-card');
  expect(section!.tagName).toBe('SECTION');
  expect(section).toHaveAttribute('tabindex', '-1');
  // UX review M1: the focused card shows the focus ring.
  expect(section).toHaveClass('focus-visible:outline-[var(--aura-focus-ring)]');
  expect(section).toHaveAttribute('aria-labelledby', 'payment-heading');
  const heading = document.getElementById('payment-heading');
  expect(heading?.tagName).toBe('H2');
  expect(heading).toHaveTextContent('Payment');
});

it('renders the bank block fields', () => {
  wrap(<PaymentSection {...BASE_PROPS} bankName="Kasikornbank" />);
  expect(screen.getByLabelText(/^bank$/i)).toHaveValue('Kasikornbank');
  expect(screen.getByLabelText(/swift/i)).toBeInTheDocument();
});

it('renders the payment instructions fields', () => {
  wrap(<PaymentSection {...BASE_PROPS} />);
  expect(screen.getByLabelText(/payment instructions \(thai\)/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/payment instructions \(english\)/i)).toBeInTheDocument();
});

it('renders the six bank text fields as 44px AURA boxes', () => {
  wrap(<PaymentSection {...BASE_PROPS} />);
  for (const id of ['bank_payee', 'bank_name', 'bank_account_no', 'bank_account_type', 'bank_branch', 'bank_swift']) {
    expect(document.getElementById(id)?.closest('.aura-input.is-touch-always, .is-touch-always .aura-input'), id).not.toBeNull();
  }
  for (const id of ['bank_address', 'pay_instr_th', 'pay_instr_en']) {
    expect(document.getElementById(id)?.closest('.aura-field'), id).not.toBeNull();
  }
});
