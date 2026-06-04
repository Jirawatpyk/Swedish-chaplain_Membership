/**
 * Component tests for the invoice-type selector + form switch
 * (054-event-fee-invoices Task 10).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { InvoiceCreateSwitcher } from '@/app/(staff)/admin/invoices/new/_components/invoice-create-switcher';
import enMessages from '@/i18n/messages/en.json';

const members = [
  {
    memberId: 'm-1',
    label: 'Acme (Regular / 2026)',
    currentPlanId: 'regular',
    currentPlanYear: 2026,
  },
];
const plans = [{ planId: 'regular', label: 'Regular', annualFeeMinorUnits: 1000000 }];
const events = [{ eventId: 'ev-1', label: 'Gala (2026-06-01)' }];

function renderSwitcher(props: Partial<Parameters<typeof InvoiceCreateSwitcher>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <InvoiceCreateSwitcher members={members} plans={plans} events={events} {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<InvoiceCreateSwitcher>', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ registrations: [] }), { status: 200 })),
    );
  });
  afterEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  it('renders a 2-option radiogroup (Membership default + Event fee)', () => {
    renderSwitcher();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Membership' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Event fee' })).not.toBeChecked();
  });

  it('shows the membership member picker by default', () => {
    renderSwitcher();
    // Membership form has the member combobox label.
    expect(
      screen.getByRole('combobox', {
        name: enMessages.admin.invoices.form.fields.memberId,
      }),
    ).toBeInTheDocument();
    // Event picker should NOT be present yet.
    expect(
      screen.queryByRole('combobox', {
        name: enMessages.admin.invoices.eventFeeForm.eventPicker.label,
      }),
    ).toBeNull();
  });

  it('switches to the event-fee form when Event fee is selected', async () => {
    renderSwitcher();
    // base-ui Radio toggles via its associated <label>, not a click on the
    // role=radio element itself — click the "Event fee" label text.
    fireEvent.click(screen.getByText('Event fee'));

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Event fee' })).toBeChecked(),
    );
    expect(
      screen.getByRole('combobox', {
        name: enMessages.admin.invoices.eventFeeForm.eventPicker.label,
      }),
    ).toBeInTheDocument();
    // Membership member picker is gone.
    expect(
      screen.queryByRole('combobox', {
        name: enMessages.admin.invoices.form.fields.memberId,
      }),
    ).toBeNull();
  });

  it('starts on the Event tab when an eventRegistration deep-link is present', () => {
    renderSwitcher({ initialEventId: 'ev-1', initialRegistrationId: 'reg-1' });
    expect(screen.getByRole('radio', { name: 'Event fee' })).toBeChecked();
    expect(
      screen.getByRole('combobox', {
        name: enMessages.admin.invoices.eventFeeForm.eventPicker.label,
      }),
    ).toBeInTheDocument();
  });
});
