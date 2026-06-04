/**
 * Component + pure-logic tests for the non-member buyer sub-form
 * (054-event-fee-invoices Task 11).
 *
 * Validation mirrors `createEventInvoiceDraftSchema.buyer` — the inline
 * errors must catch the same cases the server's zod schema rejects.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import {
  NonMemberBuyerFields,
  validateNonMemberBuyer,
  isNonMemberBuyerValid,
  EMPTY_NON_MEMBER_BUYER,
  type NonMemberBuyer,
} from '@/app/(staff)/admin/invoices/new/_components/non-member-buyer-fields';

const messages = {
  admin: {
    invoices: {
      eventFeeForm: {
        buyer: {
          nonMemberLegend: 'Non-member buyer details',
          legalName: 'Legal name',
          legalNamePlaceholder: 'Company or individual legal name',
          address: 'Address',
          addressPlaceholder: 'Billing address',
          taxId: 'Tax ID (optional)',
          taxIdPlaceholder: '13-digit Thai tax ID',
          contactName: 'Contact name (optional)',
          contactEmail: 'Contact email (optional)',
          errors: {
            legalNameRequired: 'Legal name is required.',
            legalNameTooLong: 'Legal name must be 500 characters or fewer.',
            addressRequired: 'Address is required.',
            addressTooLong: 'Address must be 1,000 characters or fewer.',
            taxIdFormat: 'Tax ID must be exactly 13 digits.',
            contactEmailFormat: 'Enter a valid email address.',
          },
        },
      },
    },
  },
};

function valid(): NonMemberBuyer {
  return {
    legalName: 'Acme Co., Ltd.',
    address: '1 Sukhumvit Rd, Bangkok',
    taxId: '',
    contactName: 'Jane',
    contactEmail: '',
  };
}

describe('validateNonMemberBuyer (pure)', () => {
  it('accepts a minimal valid buyer (empty optional fields)', () => {
    const errors = validateNonMemberBuyer(valid());
    expect(errors).toEqual({
      legalName: null,
      address: null,
      taxId: null,
      contactEmail: null,
    });
    expect(isNonMemberBuyerValid(valid())).toBe(true);
  });

  it('flags an empty legal_name', () => {
    expect(validateNonMemberBuyer({ ...valid(), legalName: '   ' }).legalName).toBe(
      'legalNameRequired',
    );
  });

  it('flags an over-long legal_name with a DISTINCT key (W3 — not "required")', () => {
    expect(validateNonMemberBuyer({ ...valid(), legalName: 'x'.repeat(501) }).legalName).toBe(
      'legalNameTooLong',
    );
  });

  it('flags an empty address', () => {
    expect(validateNonMemberBuyer({ ...valid(), address: '' }).address).toBe(
      'addressRequired',
    );
  });

  it('flags an over-long address with a DISTINCT key (W3 — not "required")', () => {
    expect(validateNonMemberBuyer({ ...valid(), address: 'x'.repeat(1001) }).address).toBe(
      'addressTooLong',
    );
  });

  it('flags a malformed tax_id (not 13 digits)', () => {
    expect(validateNonMemberBuyer({ ...valid(), taxId: '12' }).taxId).toBe('taxIdFormat');
    expect(validateNonMemberBuyer({ ...valid(), taxId: '12345678901234' }).taxId).toBe(
      'taxIdFormat',
    );
  });

  it('accepts a well-formed 13-digit tax_id', () => {
    expect(validateNonMemberBuyer({ ...valid(), taxId: '1234567890123' }).taxId).toBeNull();
  });

  it('flags a malformed contact email but accepts empty', () => {
    expect(
      validateNonMemberBuyer({ ...valid(), contactEmail: 'not-an-email' }).contactEmail,
    ).toBe('contactEmailFormat');
    expect(validateNonMemberBuyer({ ...valid(), contactEmail: '' }).contactEmail).toBeNull();
    expect(
      validateNonMemberBuyer({ ...valid(), contactEmail: 'a@b.co' }).contactEmail,
    ).toBeNull();
  });
});

describe('<NonMemberBuyerFields>', () => {
  function renderFields(errors = {}) {
    return render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <NonMemberBuyerFields
          value={EMPTY_NON_MEMBER_BUYER}
          onChange={vi.fn()}
          errors={errors}
        />
      </NextIntlClientProvider>,
    );
  }

  // W4 — required labels now carry a visible "*" marker, so the label text
  // is "Legal name *" / "Address *". Match by regex (the marker is part of
  // the visible label; it's aria-hidden so SR users rely on aria-required).
  it('renders legal name + address + tax id fields', () => {
    renderFields();
    expect(screen.getByLabelText(/Legal name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Address/)).toBeInTheDocument();
    expect(screen.getByLabelText('Tax ID (optional)')).toBeInTheDocument();
  });

  it('marks required fields with a visible "*" and aria-required (W4)', () => {
    renderFields();
    const legalName = screen.getByLabelText(/Legal name/);
    expect(legalName).toHaveAttribute('aria-required', 'true');
    // The asterisk is rendered but hidden from the a11y tree.
    const marker = document.querySelector('label[for="buyer-legal-name"] span[aria-hidden]');
    expect(marker).toHaveTextContent('*');
  });

  it('sets autocomplete attributes on buyer fields (S3)', () => {
    renderFields();
    expect(screen.getByLabelText(/Legal name/)).toHaveAttribute('autocomplete', 'organization');
    expect(screen.getByLabelText(/Address/)).toHaveAttribute('autocomplete', 'street-address');
    expect(screen.getByLabelText('Contact name (optional)')).toHaveAttribute(
      'autocomplete',
      'name',
    );
    expect(screen.getByLabelText('Contact email (optional)')).toHaveAttribute(
      'autocomplete',
      'email',
    );
  });

  it('wires aria-invalid + aria-describedby on a field error', () => {
    renderFields({ legalName: 'Legal name is required.' });
    const input = screen.getByLabelText(/Legal name/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'buyer-legal-name-error');
    expect(screen.getByRole('alert')).toHaveTextContent('Legal name is required.');
  });

  it('has no error markup when errors are empty', () => {
    renderFields();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText(/Legal name/)).not.toHaveAttribute('aria-invalid');
  });
});
