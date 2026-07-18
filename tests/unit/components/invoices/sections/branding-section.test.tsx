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

it('renders the section root with the nav-targeted heading', () => {
  wrap(<BrandingSection {...BASE_PROPS} />);
  const section = document.getElementById('branding');
  expect(section).not.toBeNull();
  const heading = section?.querySelector('[data-section-heading]');
  expect(heading).toHaveAttribute('id', 'branding-heading');
  expect(heading).toHaveAttribute('tabindex', '-1');
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
