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

it('renders fiscal-year/net-days/pro-rate fields (former "Defaults" fieldset minus auto-email)', () => {
  wrap(<NumberingSection {...BASE_PROPS} />);
  expect(screen.getByLabelText(/fiscal year start month/i)).toHaveValue(1);
  expect(screen.getByLabelText(/default net days/i)).toHaveValue(30);
  expect(screen.queryByLabelText(/auto-email/i)).not.toBeInTheDocument();
});
