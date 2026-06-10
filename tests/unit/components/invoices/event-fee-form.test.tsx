/**
 * Component tests for the event-fee invoice creation form
 * (054-event-fee-invoices Task 11; 064-event-invoice-paid-flow Task 13).
 *
 * Covers: VAT-inclusive preview math, doc-type badge flip on TIN presence,
 * the submit body shape (matched vs non-member, amountOverride only when
 * the price was edited), the 409 duplicate dialog, non-member buyer
 * validation blocking submit, the §2.3 issuance-mode mapping
 * (`defaultModeFor`, all 6 F6 payment statuses × TIN), and the two-step
 * as-paid submit (event-draft POST → issue-as-paid POST, draft-remains
 * error handling).
 *
 * The form's attendee picker fetches `/api/admin/events/[id]` — we mock
 * global fetch. `useTransition` + fetch require real timers, so this file
 * overrides the global fake-timer setup.
 *
 * Base UI Radio gotcha (same as invoice-create-switcher.test): the radio
 * toggles via a click on its associated <label> text, not on the
 * role=radio element itself.
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
  defaultModeFor,
  displayDocType,
  previewVatInclusive,
  resolveDocType,
  type EventOption,
  type IssuanceMode,
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

const paidNonMemberRegistration = {
  ...nonMemberRegistration,
  registrationId: 'dddddddd-4444-4444-8444-dddddddddddd',
  attendeeName: 'Dora (paid guest)',
  paymentStatus: 'paid',
};

const refundedRegistration = {
  ...nonMemberRegistration,
  registrationId: 'cccccccc-3333-4333-8333-cccccccccccc',
  attendeeName: 'Carol (refunded)',
  paymentStatus: 'refunded',
};

const modeMessages = enMessages.admin.invoices.eventFeeForm.mode;
const asPaidMessages = enMessages.admin.invoices.issueAsPaid;

/** Same Bangkok-today derivation the form uses for the default paymentDate. */
function bangkokToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

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

describe('resolveDocType (pure helper)', () => {
  const anyRow = {
    registrationId: 'r-1',
    attendeeName: 'Test',
    attendeeCompany: null,
    matchType: 'non_member' as const,
    matchedMemberId: null,
    ticketPriceThb: null,
    paymentStatus: 'paid' as const,
    isPseudonymised: false,
  };

  it('no attendee → pending', () => {
    expect(resolveDocType(null, false, '')).toBe('pending');
    expect(resolveDocType(null, false, '1234567890123')).toBe('pending');
  });

  it('matched member → pending (TIN unknown client-side)', () => {
    expect(resolveDocType(anyRow, true, '')).toBe('pending');
    expect(resolveDocType(anyRow, true, '1234567890123')).toBe('pending');
  });

  it('non-member with non-empty TIN → taxInvoice', () => {
    expect(resolveDocType(anyRow, false, '1234567890123')).toBe('taxInvoice');
    // whitespace-only is NOT a TIN
    expect(resolveDocType(anyRow, false, '   ')).toBe('receipt');
  });

  it('non-member without TIN → receipt', () => {
    expect(resolveDocType(anyRow, false, '')).toBe('receipt');
  });
});

describe('defaultModeFor (pure, 064 §2.3 — all 6 F6 statuses × TIN)', () => {
  const cases: ReadonlyArray<
    [status: string, hasTin: boolean, expected: { mode: IssuanceMode | null; locked: 'refunded' | null }]
  > = [
    // paid → always defaults to already_paid (bill_first switch is a UI
    // affordance gated on TIN, not a default).
    ['paid', true, { mode: 'already_paid', locked: null }],
    ['paid', false, { mode: 'already_paid', locked: null }],
    // pending/waitlisted → bill_first when TIN; NO default when no TIN
    // (waiting explainer; already_paid override stays available in the UI).
    ['pending', true, { mode: 'bill_first', locked: null }],
    ['pending', false, { mode: null, locked: null }],
    ['waitlisted', true, { mode: 'bill_first', locked: null }],
    ['waitlisted', false, { mode: null, locked: null }],
    // free → explicit choice (amountOverride path).
    ['free', true, { mode: null, locked: null }],
    ['free', false, { mode: null, locked: null }],
    // refunded → hard block, no override.
    ['refunded', true, { mode: null, locked: 'refunded' }],
    ['refunded', false, { mode: null, locked: 'refunded' }],
    // no_show → explicit choice.
    ['no_show', true, { mode: null, locked: null }],
    ['no_show', false, { mode: null, locked: null }],
  ];

  it.each(cases)('%s (hasTin=%s)', (status, hasTin, expected) => {
    expect(defaultModeFor(status, hasTin)).toEqual(expected);
  });

  it('unrecognised / empty status → defensively no default, not locked', () => {
    expect(defaultModeFor('', true)).toEqual({ mode: null, locked: null });
    expect(defaultModeFor('something_new', false)).toEqual({ mode: null, locked: null });
  });

  it('never defaults to bill_first without a TIN (global no-TIN rule)', () => {
    for (const status of ['paid', 'pending', 'refunded', 'free', 'waitlisted', 'no_show']) {
      expect(defaultModeFor(status, false).mode).not.toBe('bill_first');
    }
  });
});

describe('displayDocType (pure — as-paid combined-document flip)', () => {
  it('already_paid upgrades taxInvoice to the combined kind only', () => {
    expect(displayDocType('taxInvoice', 'already_paid')).toBe('taxInvoiceReceipt');
    expect(displayDocType('receipt', 'already_paid')).toBe('receipt');
    expect(displayDocType('pending', 'already_paid')).toBe('pending');
  });

  it('bill_first / no mode leave the base kind unchanged', () => {
    expect(displayDocType('taxInvoice', 'bill_first')).toBe('taxInvoice');
    expect(displayDocType('taxInvoice', null)).toBe('taxInvoice');
    expect(displayDocType('receipt', null)).toBe('receipt');
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

    // pending + no TIN → no default mode (§2.3): override to already_paid.
    fireEvent.click(screen.getByText(modeMessages.alreadyPaid.label));
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: new RegExp(modeMessages.alreadyPaid.label) }),
      ).toBeChecked(),
    );

    // The attendee fetch already fired on mount; the NEXT two fetches are
    // the create POST (201) and the issue-as-paid POST (200).
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-9' }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-9' }), { status: 200 }),
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

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
    expect(toastSuccess).toHaveBeenCalledWith(asPaidMessages.success);
  });

  it('matched member submit posts amountOverride when the price was edited (bill_first)', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    // paid → defaults to already_paid; a matched member counts as has-TIN
    // so bill_first stays selectable — switch to keep the draft-only flow.
    fireEvent.click(screen.getByText(modeMessages.billFirst.label));
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: new RegExp(modeMessages.billFirst.label) }),
      ).toBeChecked(),
    );

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
    // bill_first must NOT call issue-as-paid.
    expect(
      fetchMock.mock.calls.find((c) => String(c[0]).includes('/issue-as-paid')),
    ).toBeUndefined();
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
    // paid → default mode is already_paid, so the single button reads
    // "Record payment & issue receipt". The 409 fires on the FIRST call —
    // no issue-as-paid call happens.
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    expect(
      await screen.findByText(
        enMessages.admin.invoices.eventFeeForm.duplicateDialog.title,
      ),
    ).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.find((c) => String(c[0]).includes('/issue-as-paid')),
    ).toBeUndefined();
  });

  it('non-member with empty buyer → inline errors + no POST', async () => {
    const fetchMock = mockFetchRegistrations([nonMemberRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));

    // pending + no TIN → no default mode; pick already_paid to enable submit.
    fireEvent.click(screen.getByText(modeMessages.alreadyPaid.label));
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: new RegExp(modeMessages.alreadyPaid.label) }),
      ).toBeChecked(),
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

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

  // ── 064 Task 13 — issuance-mode selector + as-paid submit ──────────────

  it('paid registration → already_paid pre-selected, payment fields visible, two-step POST', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    // F6 'paid' → already_paid is the pre-selected default.
    expect(
      screen.getByRole('radio', { name: new RegExp(modeMessages.alreadyPaid.label) }),
    ).toBeChecked();
    // Payment-date (defaulted to Bangkok today, max-clamped) + method select.
    const dateInput = screen.getByLabelText(
      enMessages.admin.invoices.pay.fields.date,
    ) as HTMLInputElement;
    expect(dateInput.value).toBe(bangkokToday());
    expect(dateInput.max).toBe(bangkokToday());
    expect(screen.getByTestId('as-paid-fields')).toBeInTheDocument();

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-11' }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-11' }), { status: 200 }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-11'));
    const issueCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/issue-as-paid'),
    );
    expect(issueCall).toBeTruthy();
    expect(String(issueCall![0])).toBe('/api/invoices/inv-11/issue-as-paid');
    const issueBody = JSON.parse((issueCall![1] as RequestInit).body as string);
    expect(issueBody).toEqual({
      paymentDate: bangkokToday(),
      paymentMethod: 'bank_transfer',
    });
    expect(toastSuccess).toHaveBeenCalledWith(asPaidMessages.success);
  });

  it('issue-as-paid failure → mapped error toast + draft-remains notice + still lands on the draft', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-12' }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: { code: 'payment_date_future' } }), {
          status: 422,
        }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    // The draft EXISTS — the UI must not pretend nothing was created: the
    // toast says the draft remains and we navigate to its detail page.
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-12'));
    expect(toastError).toHaveBeenCalledWith(asPaidMessages.errors.payment_date_future, {
      description: asPaidMessages.draftRemains,
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('refunded registration → hard-block card, no mode selector, submit disabled', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([refundedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Carol/ }));

    // Canonical destructive-card pattern (archived-banner): semibold title +
    // factual body. The icon is decorative (aria-hidden).
    expect(screen.getByTestId('mode-refunded-blocked')).toHaveTextContent(
      modeMessages.refundedBlockedTitle,
    );
    expect(screen.getByTestId('mode-refunded-blocked')).toHaveTextContent(
      modeMessages.refundedBlocked,
    );
    expect(screen.queryByTestId('mode-selector')).toBeNull();
    expect(screen.queryByTestId('as-paid-fields')).toBeNull();
    // No mode → submit stays disabled (label falls back to the draft copy).
    expect(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.submit,
      }),
    ).toBeDisabled();
  });

  it('pending non-member without TIN → waiting explainer + bill_first disabled; typing a TIN flips the default to bill_first', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([nonMemberRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));

    // No default mode → waiting explainer + visible disabled-option reason.
    expect(screen.getByTestId('mode-waiting-explainer')).toHaveTextContent(
      modeMessages.waitingExplainer,
    );
    expect(screen.getByTestId('mode-bill-first-needs-tin')).toHaveTextContent(
      modeMessages.billFirstNeedsTin,
    );
    const billFirstRadio = screen.getByRole('radio', {
      name: new RegExp(modeMessages.billFirst.label),
    });
    // Base UI renders a disabled radio as <span role="radio"
    // aria-disabled="true"> (not a natively-disabled element), so jest-dom's
    // toBeDisabled() does not apply — assert the ARIA state directly.
    expect(billFirstRadio).toHaveAttribute('aria-disabled', 'true');
    // The visible disabled-option reason is programmatically associated with
    // the radio (SR users hear WHY it is disabled, not just that it is).
    expect(billFirstRadio).toHaveAttribute(
      'aria-describedby',
      'mode-bill-first-needs-tin',
    );
    expect(document.getElementById('mode-bill-first-needs-tin')).toBe(
      screen.getByTestId('mode-bill-first-needs-tin'),
    );
    expect(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.submit,
      }),
    ).toBeDisabled();

    // Typing a TIN → §2.3 default for pending+TIN is bill_first (reactive,
    // no explicit pick yet) and the option enables.
    fireEvent.change(screen.getByLabelText('Tax ID (optional)'), {
      target: { value: '1234567890123' },
    });
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: new RegExp(modeMessages.billFirst.label) }),
      ).toBeChecked(),
    );
    expect(screen.queryByTestId('mode-waiting-explainer')).toBeNull();
    expect(screen.queryByTestId('mode-bill-first-needs-tin')).toBeNull();
    // The reason is gone → the describedby reference must go with it.
    expect(
      screen.getByRole('radio', { name: new RegExp(modeMessages.billFirst.label) }),
    ).not.toHaveAttribute('aria-describedby');
  });

  it('paid non-member with a TIN → combined Tax Invoice/Receipt badge (as-paid kind)', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([paidNonMemberRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Dora/ }));

    // No TIN yet → plain receipt even on the as-paid path.
    expect(screen.getByTestId('doc-type-badge')).toHaveTextContent(
      enMessages.admin.invoices.eventFeeForm.docType.receipt,
    );

    fireEvent.change(screen.getByLabelText('Tax ID (optional)'), {
      target: { value: '1234567890123' },
    });
    // paid → already_paid default + TIN → the ONE combined document.
    expect(screen.getByTestId('doc-type-badge')).toHaveTextContent(
      enMessages.admin.invoices.eventFeeForm.docType.taxInvoiceReceipt,
    );
  });

  it('mode-radio label wiring produces no duplicate "-label" ids (duplicate-id-aria)', async () => {
    // Base UI's labelable provider assigns `label.id = "{radioId}-label"` to
    // an id-less associated <label> — colliding with the hardcoded ids on the
    // inner name-spans. The explicit `aria-labelledby` prop on each
    // RadioGroupItem suppresses that assignment. jsdom runs the same layout
    // effect, so a regression reproduces here; the authoritative proof for
    // real browsers is the axe (`duplicate-id-aria`) run in Task 14.
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    const { container } = renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    expect(screen.getByTestId('mode-selector')).toBeInTheDocument();

    const labelIds = Array.from(container.querySelectorAll('[id$="-label"]')).map(
      (el) => el.id,
    );
    const duplicates = labelIds.filter((id, i) => labelIds.indexOf(id) !== i);
    expect(duplicates).toEqual([]);

    // Each mode radio is named by its span (not the whole label incl. hint).
    expect(
      screen.getByRole('radio', { name: modeMessages.alreadyPaid.label }),
    ).toHaveAttribute('aria-labelledby', 'issuance-mode-already-paid-label');
    expect(
      screen.getByRole('radio', { name: modeMessages.billFirst.label }),
    ).toHaveAttribute('aria-labelledby', 'issuance-mode-bill-first-label');
  });

  // ── I3 — noValidate: inline i18n date errors instead of native bubbles ──

  it('as-paid submit with an empty payment date → inline dateRequired error, no POST', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    // The form opts out of native constraint validation so the i18n inline
    // errors below are what the user actually sees (the `required`/`max`
    // attributes stay for picker clamping + semantics).
    expect(container.querySelector('form')).toHaveProperty('noValidate', true);

    const dateInput = screen.getByLabelText(enMessages.admin.invoices.pay.fields.date);
    fireEvent.change(dateInput, { target: { value: '' } });
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    expect(
      await screen.findByText(
        enMessages.admin.invoices.eventFeeForm.payment.errors.dateRequired,
      ),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.find((c) => String(c[0]) === '/api/invoices/event-draft'),
    ).toBeUndefined();
  });

  it('as-paid submit with a future payment date → inline dateFuture error, no POST', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    const dateInput = screen.getByLabelText(enMessages.admin.invoices.pay.fields.date);
    // Beyond the `max` clamp — jsdom (like a paste/manual entry in some
    // browsers) accepts it; the manual validator must catch it inline.
    fireEvent.change(dateInput, { target: { value: '2099-01-01' } });
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    expect(
      await screen.findByText(
        enMessages.admin.invoices.eventFeeForm.payment.errors.dateFuture,
      ),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.find((c) => String(c[0]) === '/api/invoices/event-draft'),
    ).toBeUndefined();
  });
});
