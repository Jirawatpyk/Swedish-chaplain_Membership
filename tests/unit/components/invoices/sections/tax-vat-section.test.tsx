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

// Spec 122 US8c-2 (T856) — each section is an AURA card, focusable (the rail
// moves focus to it) and labelled by its h2.
it('renders the section as an AURA card labelled by its h2, the rail\'s focus target', () => {
  wrap(<TaxVatSection {...BASE_PROPS} />);
  const section = document.getElementById('tax');
  expect(section).not.toBeNull();
  expect(section).toHaveClass('aura-card');
  expect(section!.tagName).toBe('SECTION');
  expect(section).toHaveAttribute('tabindex', '-1');
  expect(section).toHaveAttribute('aria-labelledby', 'tax-heading');
  const heading = document.getElementById('tax-heading');
  expect(heading?.tagName).toBe('H2');
  expect(heading).toHaveTextContent('Tax');
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

it('renders the VAT and registration fee fields on AURA', () => {
  wrap(<TaxVatSection {...BASE_PROPS} />);
  for (const id of ['vat_percent', 'reg_fee']) {
    expect(document.getElementById(id)?.closest('.aura-input'), id).not.toBeNull();
  }
});
