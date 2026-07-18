import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  NumberingSection,
  type NumberingSectionProps,
} from '@/components/invoices/invoice-settings/sections/numbering-section';

const BASE_PROPS: NumberingSectionProps = {
  invoicePrefix: 'INV',
  onInvoicePrefixChange: vi.fn(),
  creditPrefix: 'CN',
  onCreditPrefixChange: vi.fn(),
  receiptPrefix: 'RC',
  onReceiptPrefixChange: vi.fn(),
  fiscalStartMonth: '1',
  onFiscalStartMonthChange: vi.fn(),
  defaultNetDays: '30',
  onDefaultNetDaysChange: vi.fn(),
  proRate: 'monthly',
  onProRateChange: vi.fn(),
  // I2 (wave B) — auto_email_enabled relocated here from
  // document-notes-section.tsx.
  autoEmail: true,
  onAutoEmailChange: vi.fn(),
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
  wrap(<NumberingSection {...BASE_PROPS} />);
  const section = document.getElementById('numbering');
  expect(section).not.toBeNull();
  const heading = section?.querySelector('[data-section-heading]');
  expect(heading).toHaveAttribute('id', 'numbering-heading');
  expect(heading).toHaveAttribute('tabindex', '-1');
});

it('renders the invoice prefix field', () => {
  wrap(<NumberingSection {...BASE_PROPS} />);
  expect(screen.getByLabelText(/invoice number prefix/i)).toHaveValue('INV');
});

it('renders the receipt numbering mode as read-only', () => {
  wrap(<NumberingSection {...BASE_PROPS} />);
  const receiptMode = screen.getByLabelText(/receipt numbering mode/i);
  expect(receiptMode).toHaveValue('Separate invoice and receipt streams');
  expect(receiptMode).toHaveAttribute('readonly');
  expect(receiptMode).toBeDisabled();
});

it('renders the fiscal-year/net-days/pro-rate fields ("Defaults" fieldset)', () => {
  wrap(<NumberingSection {...BASE_PROPS} />);
  expect(screen.getByLabelText(/fiscal year start month/i)).toHaveValue(1);
  expect(screen.getByLabelText(/default net days/i)).toHaveValue(30);
});

// I2 (wave B) — auto_email_enabled relocated here from
// document-notes-section.tsx; same id/aria-label/binding at its new home.
it('renders the relocated auto-email switch', () => {
  wrap(<NumberingSection {...BASE_PROPS} />);
  expect(screen.getByRole('switch', { name: /auto-email on issue\/payment/i })).toBeChecked();
});
