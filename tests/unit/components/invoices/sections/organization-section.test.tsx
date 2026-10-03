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

// Spec 122 US8c-2 (T856) — each section is an AURA card, focusable (the rail
// moves focus to it) and labelled by its h2.
it('renders the section as an AURA card labelled by its h2, the rail\'s focus target', () => {
  wrap(<OrganizationSection {...BASE_PROPS} />);
  const section = document.getElementById('organization');
  expect(section).not.toBeNull();
  expect(section).toHaveClass('aura-card');
  expect(section!.tagName).toBe('SECTION');
  expect(section).toHaveAttribute('tabindex', '-1');
  expect(section).toHaveAttribute('aria-labelledby', 'organization-heading');
  const heading = document.getElementById('organization-heading');
  expect(heading?.tagName).toBe('H2');
  expect(heading).toHaveTextContent('Organization');
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

it('renders the fields on AURA, the seller branch code a 44px box and the head-office toggle an AURA switch', () => {
  wrap(<OrganizationSection {...BASE_PROPS} sellerIsHeadOffice={false} />);
  for (const id of ['currency_code', 'legal_name_th', 'legal_name_en', 'brand_name', 'tax_id']) {
    expect(document.getElementById(id)?.closest('.aura-input'), id).not.toBeNull();
  }
  for (const id of ['addr_th', 'addr_en']) {
    expect(document.getElementById(id)?.closest('.aura-field'), id).not.toBeNull();
  }
  expect(document.getElementById('seller_branch')?.closest('.is-touch-always')).not.toBeNull();
  const toggle = screen.getByRole('switch', { name: /head office/i });
  expect(toggle).toHaveAttribute('id', 'seller_ho');
  expect(toggle.closest('.aura-switch-row')).not.toBeNull();
});
