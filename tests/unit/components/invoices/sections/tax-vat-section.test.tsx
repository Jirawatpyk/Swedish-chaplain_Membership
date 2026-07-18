import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  TaxVatSection,
  type TaxVatSectionProps,
} from '@/components/invoices/invoice-settings/sections/tax-vat-section';

const BASE_PROPS: TaxVatSectionProps = {
  vatPercent: '7.00',
  onVatPercentChange: vi.fn(),
  regFee: '0',
  onRegFeeChange: vi.fn(),
  currencyCode: 'THB',
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
  wrap(<TaxVatSection {...BASE_PROPS} />);
  const section = document.getElementById('tax');
  expect(section).not.toBeNull();
  const heading = section?.querySelector('[data-section-heading]');
  expect(heading).toHaveAttribute('id', 'tax-heading');
  expect(heading).toHaveAttribute('tabindex', '-1');
});

it('renders the VAT percent field', () => {
  wrap(<TaxVatSection {...BASE_PROPS} />);
  expect(screen.getByLabelText(/vat rate/i)).toHaveValue(7);
});

it('renders the registration fee field', () => {
  wrap(<TaxVatSection {...BASE_PROPS} />);
  expect(screen.getByLabelText(/registration fee/i)).toHaveValue(0);
});

// Minor (wave B) — the label used to hardcode "(THB)" even though
// currency_code is editable; it now interpolates the tenant's current
// currency.
it('interpolates the current currency code into the registration fee label', () => {
  wrap(<TaxVatSection {...BASE_PROPS} currencyCode="USD" />);
  expect(screen.getByLabelText(/registration fee \(usd\)/i)).toBeInTheDocument();
});
