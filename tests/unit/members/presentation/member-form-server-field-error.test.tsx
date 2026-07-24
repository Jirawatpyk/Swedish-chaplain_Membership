/**
 * Member form server-field-error wiring (UAT 2026-06-30 fix).
 *
 * MemberForm's `serverFieldError` prop routes a POST/PATCH rejection back to the
 * originating input: it must highlight (aria-invalid) + render the message
 * (role=alert) + focus the field (WCAG 3.3.1), and must re-fire when a NEW
 * object is supplied for the SAME field (two consecutive failed submits).
 *
 * Uses RTL + jsdom. next-intl is mocked to echo the key (as in
 * member-form-a11y.test.tsx) — the server message is passed as a literal so it
 * is asserted verbatim, independent of the i18n catalogue.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  // PR-B task 5 — CountryCombobox (rendered inside CompanySection) calls
  // useLocale() to resolve i18n-iso-countries' locale data; the minimal
  // mock above is a full replace (not `importOriginal` partial), so it
  // must also stub this export or the render throws.
  useLocale: () => 'en',
  // WP2 — MembershipSection now calls useFormatter() for the plan fee.
  useFormatter: () => ({ number: (value: number) => String(value) }),
}));

import {
  MemberForm,
  type PlanOption,
  type ResolvedServerFieldError,
} from '@/components/members/member-form';

const PLANS: PlanOption[] = [
  { plan_id: 'premium', plan_year: 2026, display_name: 'Premium — 2026' },
];

function renderForm(serverFieldError: ResolvedServerFieldError | null) {
  return render(
    <MemberForm
      plans={PLANS}
      defaultPlanYear={2026}
      onSubmit={() => undefined}
      submitting={false}
      serverFieldError={serverFieldError}
    />,
  );
}

// RHF field path → the input's DOM id in MemberForm.
const FIELD_TO_ID: Record<string, string> = {
  tax_id: 'tax_id',
  country: 'country',
  'primary_contact.email': 'contact_email',
  'primary_contact.phone': 'contact_phone',
};

describe('MemberForm serverFieldError', () => {
  it('renders no field error when serverFieldError is null', () => {
    const { container } = renderForm(null);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('#tax_id')?.getAttribute('aria-invalid')).not.toBe('true');
  });

  it.each([
    ['tax_id', 'BAD_CHECKSUM'],
    ['country', 'BAD_COUNTRY'],
    ['primary_contact.email', 'EMAIL_IN_USE'],
    ['primary_contact.phone', 'BAD_PHONE'],
  ] as const)('highlights + annotates the %s field', (field, message) => {
    const { container, getByText } = renderForm({ field, message });
    const input = container.querySelector(`#${FIELD_TO_ID[field]}`);
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    // role=alert message rendered with the verbatim server message.
    const alert = getByText(message);
    expect(alert).not.toBeNull();
    expect(alert.getAttribute('role')).toBe('alert');
    // aria-describedby links the input to its error.
    expect(input?.getAttribute('aria-describedby') ?? '').toContain(alert.id);
  });

  it('moves focus to the rejected field (WCAG 3.3.1)', () => {
    const { container } = renderForm({ field: 'tax_id', message: 'X' });
    expect(document.activeElement).toBe(container.querySelector('#tax_id'));
  });

  it('re-applies when a NEW object is supplied for the SAME field', () => {
    const { container, queryByText, rerender } = renderForm({
      field: 'tax_id',
      message: 'FIRST',
    });
    expect(queryByText('FIRST')).not.toBeNull();
    // Simulate a second failed submit on the same field with a new message
    // (a fresh object reference — the create/edit clients mint one per submit).
    rerender(
      <MemberForm
        plans={PLANS}
        defaultPlanYear={2026}
        onSubmit={() => undefined}
        submitting={false}
        serverFieldError={{ field: 'tax_id', message: 'SECOND' }}
      />,
    );
    expect(queryByText('SECOND')).not.toBeNull();
    expect(container.querySelector('#tax_id')?.getAttribute('aria-invalid')).toBe('true');
  });
});
