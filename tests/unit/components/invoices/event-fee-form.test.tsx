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
  isPastVatFilingDeadline,
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

function renderForm(
  opts: {
    initialEventId?: string;
    initialRegistrationId?: string;
    taxAtPayment?: boolean;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <EventFeeForm
        events={events}
        taxAtPayment={opts.taxAtPayment ?? false}
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

describe('isPastVatFilingDeadline (pure, 064 H-1 — ภ.พ.30 closed-period check)', () => {
  it('payment in the SAME month as today → false (period still open)', () => {
    expect(isPastVatFilingDeadline('2026-06-05', '2026-06-30')).toBe(false);
    expect(isPastVatFilingDeadline('2026-06-30', '2026-06-30')).toBe(false);
  });

  it('prior month, today = the 15th of the following month → false (deadline day itself is still timely)', () => {
    expect(isPastVatFilingDeadline('2026-05-31', '2026-06-15')).toBe(false);
    expect(isPastVatFilingDeadline('2026-05-01', '2026-06-15')).toBe(false);
  });

  it('prior month, today = the 16th of the following month → true (deadline passed)', () => {
    expect(isPastVatFilingDeadline('2026-05-31', '2026-06-16')).toBe(true);
    expect(isPastVatFilingDeadline('2026-05-01', '2026-06-16')).toBe(true);
  });

  it('year boundary: December payment, today = Jan 16 next year → true; Jan 15 → false', () => {
    expect(isPastVatFilingDeadline('2025-12-01', '2026-01-16')).toBe(true);
    expect(isPastVatFilingDeadline('2025-12-31', '2026-01-16')).toBe(true);
    expect(isPastVatFilingDeadline('2025-12-31', '2026-01-15')).toBe(false);
  });

  it('a payment several closed periods back → true', () => {
    expect(isPastVatFilingDeadline('2020-01-10', '2026-06-11')).toBe(true);
  });

  it('malformed / empty inputs → false (no warning, defensive)', () => {
    expect(isPastVatFilingDeadline('', '2026-06-11')).toBe(false);
    expect(isPastVatFilingDeadline('2026-06-11', '')).toBe(false);
    expect(isPastVatFilingDeadline('not-a-date', '2026-06-11')).toBe(false);
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

  it('088 flag ON: non-member + TIN in bill_first → badge shows the ใบแจ้งหนี้ (bill), never Tax Invoice (FR-014/SC-005)', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([nonMemberRegistration]));
    renderForm({ initialEventId: 'ev-1', taxAtPayment: true });
    fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));

    // No TIN → Receipt (the §105 path is unchanged by the flag).
    expect(screen.getByTestId('doc-type-badge')).toHaveTextContent(
      enMessages.admin.invoices.eventFeeForm.docType.receipt,
    );

    // Type a TIN → pending default is bill_first; under the flag the
    // pre-payment document is a non-tax ใบแจ้งหนี้ (the §86/4 tax receipt is
    // minted at payment), so the badge must NOT read "Tax Invoice".
    fireEvent.change(screen.getByLabelText('Tax ID (optional)'), {
      target: { value: '1234567890123' },
    });
    const badge = screen.getByTestId('doc-type-badge');
    expect(badge).toHaveTextContent(
      enMessages.admin.invoices.eventFeeForm.docType.bill088,
    );
    expect(badge).not.toHaveTextContent('Tax Invoice');
    // The bill_first hint promises an invoice at issue, not a tax invoice.
    expect(screen.getByText(modeMessages.billFirst.hint088)).toBeInTheDocument();
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
    expect(toastSuccess).toHaveBeenCalledWith(asPaidMessages.success, undefined);
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
    expect(toastSuccess).toHaveBeenCalledWith(asPaidMessages.success, undefined);
  });

  it('Cluster 5 (Finding 1 — event follow-up): issue-as-paid email_dispatch="skipped_no_email" → success toast carries the no-email warning description', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-13' }), { status: 201 }),
    );
    // The §86/4 receipt WAS issued (200), but the buyer has no contact email so
    // the route reports the auto-email was skipped.
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({ invoice_id: 'inv-13', email_dispatch: 'skipped_no_email' }),
          { status: 200 },
        ),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-13'));
    // Still a SUCCESS toast (the operation succeeded), now with a non-blocking
    // warning so the admin knows to deliver the receipt manually.
    expect(toastSuccess).toHaveBeenCalledWith(asPaidMessages.success, {
      description: asPaidMessages.successNoEmailWarning,
    });
  });

  it('issue-as-paid failure → mapped error toast + draft-remains notice + Retry action + still lands on the draft', async () => {
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
    // toast says the draft remains (honest copy: created + visible in the
    // list — there is no detail-page retry button) and we navigate to its
    // detail page. S6 — the toast itself carries the Retry action.
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-12'));
    expect(toastError).toHaveBeenCalledWith(
      asPaidMessages.errors.payment_date_future,
      expect.objectContaining({
        description: asPaidMessages.draftRemains,
        action: expect.objectContaining({ label: asPaidMessages.retry }),
      }),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('issue-as-paid 422 payment_date_too_old → mapped error toast (wave-3 S10 typo-year guard)', async () => {
    // The past-bound is server-side only (the date input clamps max= but not
    // min=); the form must surface the SPECIFIC mapped copy — telling the
    // admin the year looks mistyped / to check with the accountant — not the
    // generic codeFallback.
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-31' }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: { code: 'payment_date_too_old' } }), {
          status: 422,
        }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-31'));
    expect(toastError).toHaveBeenCalledWith(
      asPaidMessages.errors.payment_date_too_old,
      expect.objectContaining({ description: asPaidMessages.draftRemains }),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  // ── 064 remediation S6 — honest retry action on the draft-remains toast ──

  it('S6: clicking the toast Retry re-POSTs issue-as-paid; on success → success toast + happy-path navigation', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-21' }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: { code: 'pdf_render_failed' } }), {
          status: 500,
        }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    const options = toastError.mock.calls[0]![1] as {
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe(asPaidMessages.retry);

    // Retry — the SECOND issue-as-paid POST succeeds this time.
    pushMock.mockReset();
    const callsBeforeRetry = fetchMock.mock.calls.length;
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-21' }), { status: 200 }),
    );
    options.action.onClick();

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(asPaidMessages.success, undefined));
    expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-21');
    // The retry (the call AFTER the snapshot) hit the SAME invoice id with
    // the saved payment details.
    const retryCall = fetchMock.mock.calls[callsBeforeRetry];
    expect(String(retryCall![0])).toBe('/api/invoices/inv-21/issue-as-paid');
    const retryBody = JSON.parse((retryCall![1] as RequestInit).body as string);
    expect(retryBody.paymentDate).toBe(bangkokToday());
    expect(retryBody.paymentMethod).toBe('bank_transfer');
  });

  it('S6: invoice_already_issued failure → draft-remains toast WITHOUT a Retry action (row already final)', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-22' }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: { code: 'invoice_already_issued' } }), {
          status: 409,
        }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-22'));
    expect(toastError).toHaveBeenCalledTimes(1);
    const options = toastError.mock.calls[0]![1] as Record<string, unknown>;
    expect(options.description).toBe(asPaidMessages.draftRemains);
    // Retrying an already-issued row cannot help — the action is suppressed.
    expect(options).not.toHaveProperty('action');
  });

  // ── 064 remediation S4 — try/catch around the whole two-step submit ──────

  it('S4/M-3: network rejection on the issue-as-paid POST → CONNECTION copy (not unknown) WITH draft-remains + retry; lands on the draft; no unhandled rejection', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-23' }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('network down');
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-23'));
    // 065 M-3 — a network-level rejection (offline/DNS/abort) is actionable
    // ("check your connection, then retry") and must not collapse into the
    // generic unknown copy a server 500 also produces.
    expect(toastError).toHaveBeenCalledWith(
      asPaidMessages.errors.network,
      expect.objectContaining({
        description: asPaidMessages.draftRemains,
        action: expect.objectContaining({ label: asPaidMessages.retry }),
      }),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('M-3: HTTP failure WITHOUT an error code → codeFallback interpolates the HTTP status (HTTP_500), draft-remains + retry', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-24' }), { status: 201 }),
    );
    // A 500 whose body carries no `error.code` (proxy error page, Next
    // default handler) — previously indistinguishable from a network drop.
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({}), { status: 500 }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-24'));
    expect(toastError).toHaveBeenCalledWith(
      asPaidMessages.errors.codeFallback.replace('{code}', 'HTTP_500'),
      expect.objectContaining({
        description: asPaidMessages.draftRemains,
        action: expect.objectContaining({ label: asPaidMessages.retry }),
      }),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('M-1: 201 with a BROKEN body → draft-remains toast WITHOUT retry (no id) + lands on the invoice LIST; issue-as-paid never fires', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    // 201 — the draft EXISTS server-side — but the body never parses, so the
    // client has NO invoice id to navigate to or retry against.
    fetchMock.mockImplementationOnce(
      async () => new Response('not-json{', { status: 201 }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    // Honest copy: the draft remains (visible in the list) — never the bare
    // unknown toast that pretends nothing was created.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        asPaidMessages.errors.unknown,
        expect.objectContaining({ description: asPaidMessages.draftRemains }),
      ),
    );
    // No id → no retry action.
    const options = toastError.mock.calls[0]![1] as Record<string, unknown>;
    expect(options).not.toHaveProperty('action');
    // Land on the LIST (the draft is visible there), not a detail page.
    expect(pushMock).toHaveBeenCalledWith('/admin/invoices');
    // Step 2 must never fire — there is no id to issue against.
    expect(
      fetchMock.mock.calls.find((c) => String(c[0]).includes('/issue-as-paid')),
    ).toBeUndefined();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('S4: network rejection on the FIRST (event-draft) POST → plain unknown-error toast, no navigation', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('network down');
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        enMessages.admin.invoices.eventFeeForm.errors.unknown,
      ),
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  // ── 064 remediation W0 — payment date resets on attendee switch ─────────

  it('W0: a backdated payment date resets to Bangkok-today when a DIFFERENT attendee is selected', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRegistrations([matchedRegistration, paidNonMemberRegistration]),
    );
    renderForm({ initialEventId: 'ev-1' });

    // First attendee (paid → as-paid fields visible) + backdate.
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    const dateInput = screen.getByLabelText(
      enMessages.admin.invoices.pay.fields.date,
    ) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2020-01-10' } });
    expect(dateInput.value).toBe('2020-01-10');

    // Switch attendee → the backdate must NOT carry over: the date snaps
    // back to today (the field default) and the stale ภ.พ.30 warning goes.
    fireEvent.click(screen.getByRole('button', { name: /Dora/ }));
    expect(
      (screen.getByLabelText(enMessages.admin.invoices.pay.fields.date) as HTMLInputElement)
        .value,
    ).toBe(bangkokToday());
    expect(screen.queryByTestId('payment-date-vat-warning')).toBeNull();
  });

  // ── 064 remediation W2 — optional payment reference / notes ─────────────

  it('W2: reference + notes thread into the issue-as-paid body (and reset on attendee switch)', async () => {
    const fetchMock = mockFetchRegistrations([
      matchedRegistration,
      paidNonMemberRegistration,
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    const refInput = screen.getByLabelText(
      enMessages.admin.invoices.pay.fields.reference,
    ) as HTMLInputElement;
    const notesInput = screen.getByLabelText(
      enMessages.admin.invoices.pay.fields.notes,
    ) as HTMLTextAreaElement;
    fireEvent.change(refInput, { target: { value: '  TRX-12345  ' } });
    fireEvent.change(notesInput, { target: { value: 'Paid at the door (simulated)' } });

    // W0 sibling — switching attendee clears the evidence fields too.
    fireEvent.click(screen.getByRole('button', { name: /Dora/ }));
    expect(
      (screen.getByLabelText(enMessages.admin.invoices.pay.fields.reference) as HTMLInputElement)
        .value,
    ).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /Alice/ }));

    // Re-enter and submit — the trimmed values reach the step-2 POST.
    fireEvent.change(
      screen.getByLabelText(enMessages.admin.invoices.pay.fields.reference),
      { target: { value: '  TRX-12345  ' } },
    );
    fireEvent.change(
      screen.getByLabelText(enMessages.admin.invoices.pay.fields.notes),
      { target: { value: 'Paid at the door (simulated)' } },
    );
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-31' }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-31' }), { status: 200 }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-31'));
    const issueCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/issue-as-paid'),
    );
    const issueBody = JSON.parse((issueCall![1] as RequestInit).body as string);
    expect(issueBody.paymentReference).toBe('TRX-12345');
    expect(issueBody.paymentNotes).toBe('Paid at the door (simulated)');
  });

  it('W2: blank reference/notes are OMITTED from the issue-as-paid body (route records null)', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-32' }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-32' }), { status: 200 }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-32'));
    const issueCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/issue-as-paid'),
    );
    const issueBody = JSON.parse((issueCall![1] as RequestInit).body as string);
    expect(issueBody).toEqual({
      paymentDate: bangkokToday(),
      paymentMethod: 'bank_transfer',
    });
    expect(issueBody).not.toHaveProperty('paymentReference');
    expect(issueBody).not.toHaveProperty('paymentNotes');
  });

  // ── 064 remediation B5 — server-truth TIN for matched members ───────────

  it('B5: matched member with buyerHasTin=false → no-TIN rules (bill_first aria-disabled + visible reason)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRegistrations([{ ...matchedRegistration, buyerHasTin: false }]),
    );
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    // paid + no TIN → already_paid stays the default…
    expect(
      screen.getByRole('radio', { name: new RegExp(modeMessages.alreadyPaid.label) }),
    ).toBeChecked();
    // …and bill_first is DISABLED with the visible needs-TIN reason — the
    // pre-fix "matched ⇒ has TIN" guess wrongly left it selectable.
    const billFirst = screen.getByRole('radio', {
      name: new RegExp(modeMessages.billFirst.label),
    });
    expect(billFirst).toHaveAttribute('aria-disabled', 'true');
    expect(billFirst).toHaveAttribute(
      'aria-describedby',
      'mode-bill-first-needs-tin',
    );
    expect(screen.getByTestId('mode-bill-first-needs-tin')).toHaveTextContent(
      modeMessages.billFirstNeedsTin,
    );
  });

  it('B5: matched member with buyerHasTin=true → bill_first selectable (explicit server truth)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRegistrations([{ ...matchedRegistration, buyerHasTin: true }]),
    );
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fireEvent.click(screen.getByText(modeMessages.billFirst.label));
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: new RegExp(modeMessages.billFirst.label) }),
      ).toBeChecked(),
    );
    expect(screen.queryByTestId('mode-bill-first-needs-tin')).toBeNull();
  });

  it('B5: buyerHasTin ABSENT (older API shape) → legacy matched⇒has-TIN guess keeps bill_first selectable', async () => {
    // `matchedRegistration` deliberately carries NO buyerHasTin field —
    // backward compat for the API shape: the form falls back to the guess.
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    const billFirst = screen.getByRole('radio', {
      name: new RegExp(modeMessages.billFirst.label),
    });
    expect(billFirst).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByTestId('mode-bill-first-needs-tin')).toBeNull();
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

  // ── 064 H-1 — ภ.พ.30 closed-period backdate warning (spec §3.2) ─────────

  it('backdated payment date in a closed ภ.พ.30 period → non-blocking warning visible, submit stays enabled', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    // Default payment date = today → no warning.
    expect(screen.queryByTestId('payment-date-vat-warning')).toBeNull();

    // Backdate far into a closed VAT period.
    fireEvent.change(screen.getByLabelText(enMessages.admin.invoices.pay.fields.date), {
      target: { value: '2020-01-10' },
    });

    const warning = screen.getByTestId('payment-date-vat-warning');
    expect(warning).toHaveTextContent(
      enMessages.admin.invoices.eventFeeForm.payment.vatPeriodWarning,
    );
    // Warn, do NOT block (spec §3.2) — submit remains enabled.
    expect(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    ).not.toBeDisabled();
  });

  it("today's payment date → no ภ.พ.30 warning; warning clears when the date returns to an open period", async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    const dateInput = screen.getByLabelText(enMessages.admin.invoices.pay.fields.date);
    fireEvent.change(dateInput, { target: { value: '2020-01-10' } });
    expect(screen.getByTestId('payment-date-vat-warning')).toBeInTheDocument();

    fireEvent.change(dateInput, { target: { value: bangkokToday() } });
    expect(screen.queryByTestId('payment-date-vat-warning')).toBeNull();
  });
});
