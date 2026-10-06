import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  BrandingSection,
  type BrandingSectionProps,
} from '@/components/invoices/invoice-settings/sections/branding-section';

const BASE_PROPS: BrandingSectionProps = {
  logoBlobKey: null,
  uploadingLogo: false,
  logoError: null,
  onLogoChange: vi.fn(),
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
  wrap(<BrandingSection {...BASE_PROPS} />);
  const section = document.getElementById('branding');
  expect(section).not.toBeNull();
  expect(section).toHaveClass('aura-card');
  expect(section!.tagName).toBe('SECTION');
  expect(section).toHaveAttribute('tabindex', '-1');
  // UX review M1: the focused card shows the focus ring.
  expect(section).toHaveClass('focus-visible:outline-[var(--aura-focus-ring)]');
  expect(section).toHaveAttribute('aria-labelledby', 'branding-heading');
  const heading = document.getElementById('branding-heading');
  expect(heading?.tagName).toBe('H2');
  expect(heading).toHaveTextContent('Branding');
});

it('renders the logo upload field', () => {
  wrap(<BrandingSection {...BASE_PROPS} />);
  expect(screen.getByLabelText(/upload logo/i)).toBeInTheDocument();
});

it('shows the current logo key when present', () => {
  wrap(<BrandingSection {...BASE_PROPS} logoBlobKey="tenants/x/logo.png" />);
  expect(screen.getByText('tenants/x/logo.png')).toBeInTheDocument();
});

it('shows the uploading state', () => {
  wrap(<BrandingSection {...BASE_PROPS} uploadingLogo={true} />);
  expect(screen.getByText(/uploading/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/upload logo/i)).toBeDisabled();
});

it('shows a logo error as an alert', () => {
  wrap(<BrandingSection {...BASE_PROPS} logoError="File is larger than 1 MB." />);
  expect(screen.getByRole('alert')).toHaveTextContent('File is larger than 1 MB.');
});

it('keeps the native file input inside an AURA field', () => {
  wrap(<BrandingSection {...BASE_PROPS} />);
  const input = screen.getByLabelText(/upload logo/i);
  expect(input).toHaveAttribute('type', 'file');
  expect(input.closest('.aura-field')).not.toBeNull();
});

// Relay R34: at 200% text zoom the unbroken blob key overflowed the AURA card
// by 83px (WCAG 1.4.10 / 1.4.4). It must be allowed to break anywhere.
it('lets the current logo key wrap, so a long key cannot widen the card', () => {
  wrap(<BrandingSection {...BASE_PROPS} logoBlobKey="invoicing/swecham/logos/911d40b9-aaaa-bbbb-cccc-0123456789ab.png" />);
  expect(screen.getByText(/911d40b9/)).toHaveClass('[overflow-wrap:anywhere]');
});
