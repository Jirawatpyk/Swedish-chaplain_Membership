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

// Spec 122 US8c-2 (T856) — each section is an AURA card, focusable (the rail
// moves focus to it) and labelled by its h2.
it('renders the section as an AURA card labelled by its h2, the rail\'s focus target', () => {
  wrap(<NumberingSection {...BASE_PROPS} />);
  const section = document.getElementById('numbering');
  expect(section).not.toBeNull();
  expect(section).toHaveClass('aura-card');
  expect(section!.tagName).toBe('SECTION');
  expect(section).toHaveAttribute('tabindex', '-1');
  // UX review M1: the focused card shows the focus ring.
  expect(section).toHaveClass('focus-visible:outline-[var(--aura-focus-ring)]');
  expect(section).toHaveAttribute('aria-labelledby', 'numbering-heading');
  const heading = document.getElementById('numbering-heading');
  expect(heading?.tagName).toBe('H2');
  expect(heading).toHaveTextContent('Document numbering');
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

it('renders the prefixes and receipt mode as 44px AURA fields, pro-rate as an AURA Select, auto-email as an AURA switch', () => {
  wrap(<NumberingSection {...BASE_PROPS} />);
  for (const id of ['inv_prefix', 'cn_prefix', 'receipt_mode', 'rc_prefix']) {
    expect(document.getElementById(id)?.closest('.aura-input.is-touch-always, .is-touch-always .aura-input'), id).not.toBeNull();
  }
  for (const id of ['fy_month', 'net_days']) {
    expect(document.getElementById(id)?.closest('.aura-input'), id).not.toBeNull();
  }
  const proRate = screen.getByLabelText(/pro-rate policy/i);
  expect(proRate).toHaveAttribute('id', 'pro_rate');
  expect(proRate.closest('.aura-select')).not.toBeNull();
  expect(screen.getByRole('switch', { name: /auto-email on issue\/payment/i }).closest('.aura-switch-row')).not.toBeNull();
});
