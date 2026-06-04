/**
 * Component tests for the event-fee invoice creation form
 * (054-event-fee-invoices Task 11).
 *
 * Covers: VAT-inclusive preview math, doc-type badge flip on TIN presence,
 * the submit body shape (matched vs non-member, amountOverride only when
 * the price was edited), the 409 duplicate dialog, and non-member buyer
 * validation blocking submit.
 *
 * The form's attendee picker fetches `/api/admin/events/[id]` — we mock
 * global fetch. `useTransition` + fetch require real timers, so this file
 * overrides the global fake-timer setup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const { pushMock, toastSuccess, toastError } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError, info: vi.fn() },
}));

import {
  EventFeeForm,
  previewVatInclusive,
  type EventOption,
} from '@/app/(staff)/admin/invoices/new/_components/event-fee-form';
import enMessages from '@/i18n/messages/en.json';

const events: readonly EventOption[] = [
  { eventId: 'ev-1', label: 'Annual Gala (2026-06-01)' },
];

const matchedRegistration = {
  registrationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  attendeeName: 'Alice (member)',
  attendeeCompany: 'Acme',
  matchType: 'member_contact',
  matchedMemberId: 'm-1',
  ticketPriceThb: 1000,
  paymentStatus: 'paid',
  isPseudonymised: false,
};

const nonMemberRegistration = {
  registrationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  attendeeName: 'Bob (guest)',
  attendeeCompany: null,
  matchType: 'non_member',
  matchedMemberId: null,
  ticketPriceThb: 2000,
  paymentStatus: 'pending',
  isPseudonymised: false,
};

function mockFetchRegistrations(rows: readonly unknown[]) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/admin/events/')) {
      return new Response(JSON.stringify({ registrations: rows }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function renderForm(opts: { initialEventId?: string; initialRegistrationId?: string } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <EventFeeForm
        events={events}
        {...(opts.initialEventId ? { initialEventId: opts.initialEventId } : {})}
        {...(opts.initialRegistrationId
          ? { initialRegistrationId: opts.initialRegistrationId }
          : {})}
      />
    </NextIntlClientProvider>,
  );
}

describe('previewVatInclusive (pure, half-away)', () => {
  it('1070.00 THB incl @7% → subtotal 1000.00, vat 70.00 (AS-VAT-01)', () => {
    expect(previewVatInclusive(107_000)).toEqual({ subtotal: 100_000, vat: 7_000 });
  });

  it('subtotal + vat === total for boundary satang', () => {
    for (const total of [107, 214, 321, 1, 100_000_000]) {
      const { subtotal, vat } = previewVatInclusive(total);
      expect(subtotal + vat).toBe(total);
    }
  });

  it('returns zero for non-positive input', () => {
    expect(previewVatInclusive(0)).toEqual({ subtotal: 0, vat: 0 });
    expect(previewVatInclusive(-5)).toEqual({ subtotal: 0, vat: 0 });
  });
});

describe('<EventFeeForm>', () => {
  beforeEach(() => {
    vi.useRealTimers();
    pushMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });
  afterEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  it('fetches attendees for the pre-selected event and renders the picker', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    expect(await screen.findByText('Alice (member)')).toBeInTheDocument();
  });

  it('matched member → read-only buyer + pre-filled amount + VAT preview', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });

    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    expect(screen.getByTestId('matched-buyer-readonly')).toBeInTheDocument();
    // Amount pre-filled from ticketPriceThb (1000).
    expect((screen.getByLabelText(/Amount/) as HTMLInputElement).value).toBe('1000');
    // VAT preview present: 1000 THB incl → subtotal 934.58 / vat 65.42.
    const preview = screen.getByTestId('vat-preview');
    expect(preview).toHaveTextContent('1,000.00');
    expect(preview).toHaveTextContent('934.58');
    expect(preview).toHaveTextContent('65.42');
  });

  it('matched member → doc-type badge shows "set at issue" (TIN unknown client-side)', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    expect(screen.getByTestId('doc-type-badge')).toHaveTextContent(
      enMessages.admin.invoices.eventFeeForm.docType.pending,
    );
  });

  it('non-member with a TIN → doc-type badge flips to Tax Invoice', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([nonMemberRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));

    // Without a TIN → Receipt.
    expect(screen.getByTestId('doc-type-badge')).toHaveTextContent(
      enMessages.admin.invoices.eventFeeForm.docType.receipt,
    );

    fireEvent.change(screen.getByLabelText('Tax ID (optional)'), {
      target: { value: '1234567890123' },
    });
    expect(screen.getByTestId('doc-type-badge')).toHaveTextContent(
      enMessages.admin.invoices.eventFeeForm.docType.taxInvoice,
    );
  });

  it('non-member submit posts the buyer object + no amountOverride when price untouched', async () => {
    const fetchMock = mockFetchRegistrations([nonMemberRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));

    fireEvent.change(screen.getByLabelText(/Legal name/), {
      target: { value: 'Bob Guest Co.' },
    });
    fireEvent.change(screen.getByLabelText(/Address/), {
      target: { value: '99 Rama IV' },
    });

    // The attendee fetch already fired on mount; the NEXT fetch is the
    // create POST. Queue its 201 response.
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-9' }), { status: 201 }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Create event-fee draft/ }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-9'));

    const postCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/invoices/event-draft',
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.eventRegistrationId).toBe(nonMemberRegistration.registrationId);
    expect(body.amountOverride).toBeUndefined();
    expect(body.buyer).toEqual({
      legal_name: 'Bob Guest Co.',
      tax_id: null,
      address: '99 Rama IV',
      primary_contact_name: '',
      primary_contact_email: '',
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('matched member submit posts amountOverride when the price was edited', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    // Override the price 1000 → 1500.
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '1500' } });

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-7' }), { status: 201 }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Create event-fee draft/ }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-7'));
    const postCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/invoices/event-draft',
    );
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.amountOverride).toBe(150_000); // 1500 THB → satang
    expect(body.buyer).toBeUndefined(); // matched member sends no buyer
  });

  it('409 → opens the soft-duplicate dialog instead of redirecting', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: { code: 'duplicate' } }), { status: 409 }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Create event-fee draft/ }));

    expect(
      await screen.findByText(
        enMessages.admin.invoices.eventFeeForm.duplicateDialog.title,
      ),
    ).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('non-member with empty buyer → inline errors + no POST', async () => {
    const fetchMock = mockFetchRegistrations([nonMemberRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));

    fireEvent.click(screen.getByRole('button', { name: /Create event-fee draft/ }));

    expect(
      await screen.findByText(
        enMessages.admin.invoices.eventFeeForm.buyer.errors.legalNameRequired,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        enMessages.admin.invoices.eventFeeForm.buyer.errors.addressRequired,
      ),
    ).toBeInTheDocument();
    const postCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/invoices/event-draft',
    );
    expect(postCall).toBeUndefined();
  });
});
