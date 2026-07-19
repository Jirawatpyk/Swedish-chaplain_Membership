import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  OrganizationSection,
  type OrganizationSectionProps,
} from '@/components/invoices/invoice-settings/sections/organization-section';

const BASE_PROPS: OrganizationSectionProps = {
  currencyCode: 'THB',
  onCurrencyCodeChange: vi.fn(),
  legalNameTh: 'บริษัท',
  onLegalNameThChange: vi.fn(),
  legalNameEn: 'Company',
  onLegalNameEnChange: vi.fn(),
  brandName: '',
  onBrandNameChange: vi.fn(),
  taxId: '0994000187203',
  onTaxIdChange: vi.fn(),
  addrTh: 'ที่อยู่',
  onAddrThChange: vi.fn(),
  addrEn: 'Address',
  onAddrEnChange: vi.fn(),
  sellerIsHeadOffice: false,
  onSellerIsHeadOfficeChange: vi.fn(),
  sellerBranchCode: '00001',
  onSellerBranchCodeChange: vi.fn(),
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
  wrap(<OrganizationSection {...BASE_PROPS} />);
  const section = document.getElementById('organization');
  expect(section).not.toBeNull();
  const heading = section?.querySelector('[data-section-heading]');
  expect(heading).toHaveAttribute('id', 'organization-heading');
  expect(heading).toHaveAttribute('tabindex', '-1');
});

it('renders a representative identity field', () => {
  wrap(<OrganizationSection {...BASE_PROPS} />);
  expect(screen.getByLabelText(/legal name \(thai\)/i)).toHaveValue('บริษัท');
});

it('renders the seller branch input only when not head office', () => {
  wrap(<OrganizationSection {...BASE_PROPS} sellerIsHeadOffice={false} />);
  expect(screen.getByLabelText(/branch code/i)).toBeInTheDocument();
});

it('hides the seller branch input when head office', () => {
  wrap(<OrganizationSection {...BASE_PROPS} sellerIsHeadOffice={true} />);
  expect(screen.queryByLabelText(/branch code/i)).not.toBeInTheDocument();
});
