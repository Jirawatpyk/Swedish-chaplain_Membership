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

it('renders the section root with the nav-targeted heading', () => {
  wrap(<PaymentSection {...BASE_PROPS} />);
  const section = document.getElementById('payment');
  expect(section).not.toBeNull();
  const heading = section?.querySelector('[data-section-heading]');
  expect(heading).toHaveAttribute('id', 'payment-heading');
  expect(heading).toHaveAttribute('tabindex', '-1');
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
