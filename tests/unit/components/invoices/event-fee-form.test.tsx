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
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import fc from 'fast-check';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { splitVatInclusive } from '@/modules/invoicing/domain/value-objects/vat-inclusive';

const { pushMock, toastSuccess, toastError, toastWarning } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: toastSuccess, error: toastError, warning: toastWarning, info: vi.fn() },
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
import svMessages from '@/i18n/messages/sv.json';

// AURA 5.83 (#195): the Combobox note is mirrored in a visually hidden
// status region, so text queries scope to the visible note.
const NOTE = { selector: '.aura-combo__note' } as const;

/** The oldest preloaded event's start: the page sends it when it loaded a full 200. */
const SEARCH_BEFORE = '2026-01-15T03:00:00.000Z';

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
    vatRateBps?: number | null;
    locale?: 'en' | 'sv';
    events?: readonly EventOption[];
    eventSearchBefore?: string | null;
  } = {},
) {
  const locale = opts.locale ?? 'en';
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'sv' ? svMessages : enMessages}>
      <EventFeeForm
        events={opts.events ?? events}
        eventSearchBefore={opts.eventSearchBefore === undefined ? SEARCH_BEFORE : opts.eventSearchBefore}
        taxAtPayment={opts.taxAtPayment ?? false}
        vatRateBps={opts.vatRateBps === undefined ? 700 : opts.vatRateBps}
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
    expect(previewVatInclusive(107_000, 700)).toEqual({ subtotal: 100_000, vat: 7_000 });
  });

  // The preview splits at the TENANT's rate (tenant_invoice_settings.vat_rate),
  // the rate both issuance paths pin — never a hardcoded 7%.
  it('1100.00 THB incl @10% → subtotal 1000.00, vat 100.00', () => {
    expect(previewVatInclusive(110_000, 1000)).toEqual({ subtotal: 100_000, vat: 10_000 });
  });

  it('equals the domain splitVatInclusive for any total and rate (byte-for-byte)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 0, max: 3000 }),
        (total, bps) => {
          const want = splitVatInclusive(Money.fromSatangUnsafe(total), BigInt(bps));
          expect(previewVatInclusive(total, bps)).toEqual({
            subtotal: Number(want.subtotal.satang),
            vat: Number(want.vat.satang),
          });
        },
      ),
      { numRuns: 500 },
    );
  });

  it('subtotal + vat === total for boundary satang', () => {
    for (const total of [107, 214, 321, 1, 100_000_000]) {
      const { subtotal, vat } = previewVatInclusive(total, 700);
      expect(subtotal + vat).toBe(total);
    }
  });

  it('returns zero for non-positive input', () => {
    expect(previewVatInclusive(0, 700)).toEqual({ subtotal: 0, vat: 0 });
    expect(previewVatInclusive(-5, 700)).toEqual({ subtotal: 0, vat: 0 });
  });
});

describe('EventFeeForm — a deep-linked event outside the newest 200 (#54)', () => {
  // useTransition + fetch need real timers (this file's default is fake).
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubGlobal('fetch', mockFetchRegistrations([]));
  });
  afterEach(() => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
  });

  // The page loads 200 events and appends the deep-linked one as the 201st.
  const many: EventOption[] = Array.from({ length: 200 }, (_, i) => ({
    eventId: `ev-n${i}`,
    label: `Recent ${i} (2026-10-01)`,
  }));
  const old: EventOption = {
    eventId: 'ev-old',
    label: 'Old Breakfast (2025-03-04)',
    description: 'From your link (not in the recent list)',
  };

  it('the 201st option is preselected AND shown in the open list, with its marker', async () => {
    renderForm({ initialEventId: 'ev-old', events: [...many, old] });
    const input = document.getElementById('eventId') as HTMLInputElement;
    expect(input).toHaveValue('Old Breakfast (2025-03-04)');
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // Plain DOM query: role-name computation over 200 options is too slow.
    await waitFor(() => expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0));
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
      o.textContent?.includes('Old Breakfast (2025-03-04)'),
    );
    expect(option).toBeDefined();
    expect(option).toHaveTextContent('From your link (not in the recent list)');
  });
});

describe('EventFeeForm — the event picker searches the server (#732)', () => {
  // useTransition + fetch need real timers (this file's default is fake).
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
  });

  const picker = enMessages.admin.invoices.eventFeeForm.eventPicker as Record<string, string>;
  const oldEvent = { eventId: 'ev-old', name: 'Old Breakfast', startDate: '2025-03-04T02:00:00.000Z' };

  /** The list search answers `search`; the attendee route answers `rows`. */
  function stubFetch(search: (url: URL) => Response) {
    const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input), 'https://app.test');
      if (url.pathname === '/api/admin/events') return search(url);
      if (url.pathname.startsWith('/api/admin/events/')) {
        return new Response(JSON.stringify({ registrations: [matchedRegistration] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }
  const listOf = (items: unknown[]) =>
    new Response(JSON.stringify({ items, pagination: { page: 1, pageSize: 25, totalCount: items.length } }), {
      status: 200,
    });
  const searchCalls = (fn: ReturnType<typeof stubFetch>) =>
    fn.mock.calls.map((c) => new URL(String(c[0]), 'https://app.test')).filter((u) => u.pathname === '/api/admin/events');

  function typeInPicker(text: string): HTMLInputElement {
    const input = document.getElementById('eventId') as HTMLInputElement;
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: text } });
    return input;
  }

  // #89 review (UX H1) — the deep link names one registration on one event;
  // after switching to another event the picker must not say the link's
  // registration is missing from that event's list.
  it('a deep-linked registration is looked for only on its own event, not on one switched to', async () => {
    stubFetch(() => listOf([]));
    renderForm({
      events: [...events, { eventId: 'ev-2', label: 'Second Mixer (2026-07-01)' }],
      initialEventId: 'ev-1',
      initialRegistrationId: 'ffffffff-9999-4999-8999-ffffffffffff',
    });
    expect(await screen.findByTestId('attendee-picker-link-not-found', {}, { timeout: 3000 })).toBeInTheDocument();
    const input = document.getElementById('eventId') as HTMLInputElement;
    fireEvent.click(input);
    fireEvent.click(await screen.findByRole('option', { name: /Second Mixer/ }));
    await waitFor(() => expect(document.querySelectorAll('li > button').length).toBeGreaterThan(0), { timeout: 3000 });
    expect(screen.queryByTestId('attendee-picker-link-not-found')).toBeNull();
  });

  it('typing searches once after the debounce, and an event outside the loaded list can be picked', async () => {
    const fn = stubFetch(() => listOf([oldEvent]));
    renderForm();
    typeInPicker('Old');
    const option = await screen.findByRole('option', { name: /Old Breakfast \(2025-03-04\)/ });
    const calls = searchCalls(fn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.searchParams.get('q')).toBe('Old');
    expect(calls[0]?.searchParams.get('pageSize')).toBe('25');
    expect(calls[0]?.searchParams.get('startedOnOrBefore')).toBe(SEARCH_BEFORE);
    fireEvent.click(option);
    expect(document.getElementById('eventId')).toHaveValue('Old Breakfast (2025-03-04)');
    expect(await screen.findByRole('button', { name: /Alice \(member\)/ })).toBeInTheDocument();
    expect(fn.mock.calls.some((c) => String(c[0]).includes('/api/admin/events/ev-old'))).toBe(true);
  });

  it('shows the searching text while the request runs', async () => {
    let release: (r: Response) => void = () => {};
    stubFetch(() => new Promise<Response>((r) => (release = r)) as unknown as Response);
    renderForm();
    typeInPicker('Old');
    expect(await screen.findByText(picker.searching ?? '<missing eventPicker.searching>', NOTE)).toBeInTheDocument();
    release(listOf([]));
  });

  it('no match shows the empty text; a failed search shows the failed text', async () => {
    stubFetch(() => listOf([]));
    const { unmount } = renderForm();
    typeInPicker('Nothing');
    expect(await screen.findByText(picker.empty ?? '', NOTE)).toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();
    stubFetch(() => new Response('{}', { status: 500 }));
    renderForm();
    typeInPicker('Nothing');
    expect(await screen.findByText(picker.searchFailed ?? '<missing eventPicker.searchFailed>', NOTE)).toBeInTheDocument();
  });

  // #89 (UX L2) — with server search on, the field says typing reaches older events.
  it('hints that typing searches older events only when the server search is on', () => {
    stubFetch(() => listOf([]));
    const { unmount } = renderForm();
    const hint = picker.searchHint ?? '<missing eventPicker.searchHint>';
    expect(document.getElementById('eventId')).toHaveAccessibleDescription(expect.stringContaining(hint));
    unmount();
    renderForm({ eventSearchBefore: null });
    expect(document.getElementById('eventId')).not.toHaveAccessibleDescription(expect.stringContaining(hint));
  });

  it('fewer than a full page preloaded (every event is listed) → typing filters locally, no server search', async () => {
    const fn = stubFetch(() => listOf([oldEvent]));
    renderForm({ eventSearchBefore: null });
    typeInPicker('Gala');
    expect(await screen.findByRole('option', { name: /Annual Gala/ })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(searchCalls(fn)).toHaveLength(0);
  });

  it('code-review — a picked event that does not match the typed text is not offered as a match', async () => {
    stubFetch(() => listOf([]));
    renderForm({ initialEventId: 'ev-1' });
    typeInPicker('zzz');
    expect(await screen.findByText(picker.empty ?? '', NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Annual Gala/ })).not.toBeInTheDocument();
  });

  it('code-review — Escape clears the typed text, so reopening lists every event', async () => {
    stubFetch(() => listOf([]));
    const two: EventOption[] = [
      { eventId: 'ev-1', label: 'Annual Gala (2026-06-01)' },
      { eventId: 'ev-2', label: 'Spring Breakfast (2026-04-01)' },
    ];
    renderForm({ events: two });
    const input = typeInPicker('Gala');
    await screen.findByRole('option', { name: /Annual Gala/ });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(await screen.findByRole('option', { name: /Spring Breakfast/ })).toBeInTheDocument();
  });

  it('UX M1 — loaded matches stay listed while the server search is still running', async () => {
    stubFetch(() => new Promise<Response>(() => {}) as unknown as Response);
    renderForm();
    typeInPicker('Gala');
    // Past the debounce: the search request is in flight (it never answers).
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByRole('option', { name: /Annual Gala \(2026-06-01\)/ })).toBeInTheDocument();
    expect(screen.queryByText(picker.searching ?? '', NOTE)).not.toBeInTheDocument();
  });

  it('UX M2 — after a pick, reopening the picker lists every loaded event again', async () => {
    stubFetch(() => listOf([oldEvent]));
    const two: EventOption[] = [
      { eventId: 'ev-1', label: 'Annual Gala (2026-06-01)' },
      { eventId: 'ev-2', label: 'Spring Breakfast (2026-04-01)' },
    ];
    renderForm({ events: two });
    typeInPicker('Old');
    fireEvent.click(await screen.findByRole('option', { name: /Old Breakfast/ }));
    const input = document.getElementById('eventId') as HTMLInputElement;
    fireEvent.blur(input);
    // AURA's Combobox closes its list on a setTimeout(0) after blur; let that close land
    // before reopening, or a slow run (coverage) closes the reopened list under the asserts.
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.focus(input);
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(await screen.findByRole('option', { name: /Spring Breakfast/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Annual Gala/ })).toBeInTheDocument();
  });

  it('UX L1 — a failed search says so even when loaded events match', async () => {
    stubFetch(() => new Response('{}', { status: 500 }));
    renderForm();
    typeInPicker('Gala');
    // With loaded matches on show, the failure is the field's hint, not the
    // note, and (#89 a11y M3) a status line says it to screen readers.
    await waitFor(() =>
      expect(document.getElementById('eventId')).toHaveAccessibleDescription(
        expect.stringContaining(picker.searchFailed ?? '<missing>'),
      ),
    );
    expect(screen.getAllByRole('status').some((s) => s.textContent === picker.searchFailed)).toBe(true);
    expect(screen.getByRole('option', { name: /Annual Gala/ })).toBeInTheDocument();
  });

  it('UX L2 — after a failed search, typing the same text again searches again', async () => {
    let calls = 0;
    const fn = stubFetch(() => (++calls === 1 ? new Response('{}', { status: 500 }) : listOf([oldEvent])));
    renderForm();
    typeInPicker('Old');
    expect(await screen.findByText(picker.searchFailed ?? '', NOTE)).toBeInTheDocument();
    typeInPicker('Old ');
    expect(await screen.findByRole('option', { name: /Old Breakfast/ })).toBeInTheDocument();
    expect(searchCalls(fn).map((u) => u.searchParams.get('q'))).toEqual(['Old', 'Old']);
  });

  it('UX L3 — text over 100 characters is searched as its first 100, not refused', async () => {
    const fn = stubFetch(() => listOf([]));
    renderForm();
    typeInPicker('x'.repeat(130));
    expect(await screen.findByText(picker.empty ?? '', NOTE)).toBeInTheDocument();
    expect(searchCalls(fn)[0]?.searchParams.get('q')).toHaveLength(100);
  });

  it('a loaded event still matches by its date while the server finds nothing', async () => {
    stubFetch(() => listOf([]));
    renderForm();
    typeInPicker('2026-06');
    expect(await screen.findByRole('option', { name: /Annual Gala \(2026-06-01\)/ })).toBeInTheDocument();
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
    toastWarning.mockReset();
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
    expect(preview).toHaveTextContent('VAT (7%)');
  });

  it("previews at the tenant's rate: 10% → VAT (10%), 1000 THB incl → 909.09 / 90.91", async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1', vatRateBps: 1000 });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    const preview = screen.getByTestId('vat-preview');
    expect(preview).toHaveTextContent('VAT (10%)');
    expect(preview).toHaveTextContent('909.09');
    expect(preview).toHaveTextContent('90.91');
  });

  // No invoice settings → no rate to split at (issuance refuses with
  // settings_missing): show the total, never a guessed subtotal / VAT.
  it('without a tenant VAT rate, shows the total only — no guessed split', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1', vatRateBps: null });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    const preview = screen.getByTestId('vat-preview');
    expect(preview).toHaveTextContent('1,000.00');
    expect(preview).not.toHaveTextContent('934.58');
    expect(preview).not.toHaveTextContent(/VAT \d/);
    // ...and says why, with the way to fix it.
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(
      enMessages.admin.invoices.eventFeeForm.vatPreview.settingsMissing,
    );
    expect(
      screen.getByRole('link', {
        name: enMessages.admin.invoices.eventFeeForm.vatPreview.configureSettings,
      }),
    ).toHaveAttribute('href', '/admin/settings/invoicing');
  });

  // The rate is a number in running text: formatted for the locale (sv uses a
  // decimal comma and a non-breaking space before %), never a hardcoded dot.
  // An amount far past the form's maximum must not crash the form while it is
  // typed: issuance refuses it (amount.errors.max), so there is no preview to
  // draw — and a money formatter that refuses unsafe numbers must not be
  // reached with one.
  it('an amount beyond the maximum shows no preview and does not crash the form', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    expect(() =>
      fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '1e20' } }),
    ).not.toThrow();
    expect(screen.queryByTestId('vat-preview')).toBeNull();
    expect(screen.getByLabelText(/Amount/)).toBeInTheDocument();
  });

  // Same rendering as the Issue dialog and the invoice detail totals.
  it('formats the rate for the locale: 7.5% reads "Moms (7,5 %)" in Swedish', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1', vatRateBps: 750, locale: 'sv' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    // Raw textContent: toHaveTextContent would normalise the NBSP away.
    const terms = Array.from(screen.getByTestId('vat-preview').querySelectorAll('dt'));
    expect(terms.map((dt) => dt.textContent)).toContain('Moms (7,5\u00a0%)');
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

  it('409 with existing_invoice_id → duplicate dialog renders a "View invoice" link', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'duplicate' },
            existing_invoice_id: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
          }),
          { status: 409 },
        ),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await screen.findByText(
      enMessages.admin.invoices.eventFeeForm.duplicateDialog.title,
    );
    const link = screen.getByRole('link', {
      name: enMessages.admin.invoices.eventFeeForm.duplicateDialog.viewInvoice,
    });
    expect(link).toHaveAttribute(
      'href',
      '/admin/invoices/eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
    );
  });

  it('409 with existing_invoice_id: null → duplicate dialog renders only Close (no link)', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'duplicate' }, existing_invoice_id: null }),
          { status: 409 },
        ),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await screen.findByText(
      enMessages.admin.invoices.eventFeeForm.duplicateDialog.title,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    // The footer's Close (AURA's own close button shares the name).
    expect(
      screen.getAllByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.duplicateDialog.cancel,
      }).length,
    ).toBeGreaterThanOrEqual(1);
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
      new RegExp(`^${enMessages.admin.invoices.pay.fields.date}`),
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

  // #90 (R150) — the browser submits a form when Enter is pressed in one of
  // its inputs. Here that would issue a tax document with no confirm step, so
  // Enter in a field is cancelled; only the button submits. jsdom does not
  // perform implicit submission, so the cancelled keydown is the evidence.
  describe('Enter in a field never submits (#90)', () => {
    async function completeAsPaidForm() {
      const fetchMock = mockFetchRegistrations([matchedRegistration]);
      vi.stubGlobal('fetch', fetchMock);
      renderForm({ initialEventId: 'ev-1' });
      fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
      expect(
        screen.getByRole('radio', { name: new RegExp(modeMessages.alreadyPaid.label) }),
      ).toBeChecked();
      return fetchMock;
    }

    it('Enter in the event picker, the amount, the payment date and a mode radio is cancelled', async () => {
      const fetchMock = await completeAsPaidForm();
      const fields = [
        screen.getByRole('combobox', { name: new RegExp(enMessages.admin.invoices.eventFeeForm.eventPicker.label) }),
        screen.getByLabelText(/Amount/),
        screen.getByLabelText(new RegExp(`^${enMessages.admin.invoices.pay.fields.date}`)),
        screen.getByRole('radio', { name: new RegExp(modeMessages.alreadyPaid.label) }),
      ];
      for (const field of fields) {
        expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false);
      }
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]) === '/api/invoices/event-draft'),
      ).toBe(false);
    });

    it('Enter on the submit button is left alone', async () => {
      await completeAsPaidForm();
      const button = screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      });
      expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(true);
    });

    it('an Enter that commits IME composition is left alone', async () => {
      await completeAsPaidForm();
      expect(
        fireEvent.keyDown(screen.getByLabelText(/Amount/), { key: 'Enter', isComposing: true }),
      ).toBe(true);
    });
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

  // #61 — no answer on the issue-as-paid POST (a drop or the timeout) and a
  // 5xx naming no refusal both leave the outcome UNKNOWN: the as-paid issue may
  // have committed (receipt numbered). Say so in a warning, without claiming
  // the draft remains and without a blind Retry; the detail page it lands on
  // shows the real status.
  it('#61: network rejection on the issue-as-paid POST → UNCONFIRMED warning, no draft-remains claim, no Retry; lands on the invoice', async () => {
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
    expect(toastWarning).toHaveBeenCalledTimes(1);
    const [title, options] = toastWarning.mock.calls[0]!;
    expect(title).toBe(asPaidMessages.errors.unconfirmed);
    expect(title).toBe(
      "We couldn't confirm whether the invoice was issued as paid. Check its status on the invoice before you try again.",
    );
    // #727 review (UX H3) — it stays across the navigation until dismissed.
    expect(options).toEqual({ duration: Infinity });
    expect(options ?? {}).not.toHaveProperty('action');
    expect(JSON.stringify(options ?? {})).not.toContain(asPaidMessages.draftRemains);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    // The as-paid POST carries the money-POST timeout.
    expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('#61: a 504 / a 500 naming no code on the issue-as-paid POST → the same UNCONFIRMED warning (not "Error code: HTTP_500")', async () => {
    for (const [i, res] of [
      () => new Response('<html>Gateway Timeout</html>', { status: 504 }),
      () => new Response(JSON.stringify({}), { status: 500 }),
    ].entries()) {
      const fetchMock = mockFetchRegistrations([matchedRegistration]);
      vi.stubGlobal('fetch', fetchMock);
      const view = renderForm({ initialEventId: 'ev-1' });
      fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ invoice_id: `inv-2${4 + i}` }), { status: 201 }),
      );
      fetchMock.mockImplementationOnce(async () => res());
      fireEvent.click(
        screen.getByRole('button', {
          name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
        }),
      );
      await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/admin/invoices/inv-2${4 + i}`));
      expect(toastWarning).toHaveBeenLastCalledWith(asPaidMessages.errors.unconfirmed, { duration: Infinity });
      expect(toastError).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('#727 review: offline, the unconfirmed toast shows and the navigation waits for the connection', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-27' }), { status: 201 }),
    );
    const onLine = vi.spyOn(navigator, 'onLine', 'get');
    fetchMock.mockImplementationOnce(async () => {
      onLine.mockReturnValue(false);
      throw new TypeError('Failed to fetch');
    });
    try {
      fireEvent.click(
        screen.getByRole('button', {
          name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
        }),
      );
      await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
      // A navigation while offline falls onto the browser's offline page and
      // loses the toast (#48), so it waits.
      expect(pushMock).not.toHaveBeenCalled();
      onLine.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
      expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-27');
    } finally {
      onLine.mockRestore();
    }
  });

  it('M-3: a refusal WITHOUT an error code below 500 → codeFallback interpolates the HTTP status, draft-remains + retry', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-28' }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(
      async () => new Response('<html>Payload Too Large</html>', { status: 413 }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-28'));
    expect(toastError).toHaveBeenCalledWith(
      asPaidMessages.errors.codeFallback.replace('{code}', 'HTTP_413'),
      expect.objectContaining({
        description: asPaidMessages.draftRemains,
        action: expect.objectContaining({ label: asPaidMessages.retry }),
      }),
    );
  });

  it('#61: the READ_ONLY_MODE 503 on the issue-as-paid POST → the read-only warning, nothing changed, draft remains, no Retry', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ invoice_id: 'inv-26' }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'read-only-mode' }), { status: 503 }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: enMessages.admin.invoices.eventFeeForm.recordAndIssue,
      }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-26'));
    expect(toastWarning).toHaveBeenCalledWith(enMessages.errors.readOnlyMode, {
      description: `${enMessages.errors.readOnlyNothingChanged} ${asPaidMessages.draftRemains}`,
      duration: 10_000,
    });
    expect(toastError).not.toHaveBeenCalled();
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
      new RegExp(`^${enMessages.admin.invoices.pay.fields.date}`),
    ) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2020-01-10' } });
    expect(dateInput.value).toBe('2020-01-10');

    // Switch attendee → the backdate must NOT carry over: the date snaps
    // back to today (the field default) and the stale ภ.พ.30 warning goes.
    fireEvent.click(screen.getByRole('button', { name: /Dora/ }));
    expect(
      (screen.getByLabelText(new RegExp(`^${enMessages.admin.invoices.pay.fields.date}`)) as HTMLInputElement)
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

  it('B5: matched member with buyerIsVatRegistrant=false → no-TIN rules (bill_first aria-disabled + visible reason)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRegistrations([{ ...matchedRegistration, buyerIsVatRegistrant: false }]),
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
    // AURA radio: natively disabled, named by its label alone with the reason
    // read after it as its description (AURA 5.26, handoff #125).
    expect(billFirst).toBeDisabled();
    expect(billFirst).toHaveAccessibleName(modeMessages.billFirst.label);
    expect(billFirst).toHaveAccessibleDescription(modeMessages.billFirstNeedsTin);
  });

  it('B5: matched member with buyerIsVatRegistrant=true → bill_first selectable (explicit server truth)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRegistrations([{ ...matchedRegistration, buyerIsVatRegistrant: true }]),
    );
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    fireEvent.click(screen.getByRole('radio', { name: new RegExp(modeMessages.billFirst.label) }));
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: new RegExp(modeMessages.billFirst.label) }),
      ).toBeChecked(),
    );
    expect(screen.queryByText(modeMessages.billFirstNeedsTin)).toBeNull();
  });

  it('B5: buyerIsVatRegistrant ABSENT (older API shape) → legacy matched⇒has-TIN guess keeps bill_first selectable', async () => {
    // `matchedRegistration` deliberately carries NO buyerIsVatRegistrant field —
    // backward compat for the API shape: the form falls back to the guess.
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    const billFirst = screen.getByRole('radio', {
      name: new RegExp(modeMessages.billFirst.label),
    });
    expect(billFirst).toBeEnabled();
    expect(screen.queryByText(modeMessages.billFirstNeedsTin)).toBeNull();
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
    const billFirstRadio = screen.getByRole('radio', {
      name: new RegExp(modeMessages.billFirst.label),
    });
    // Spec 122 US8 (T807) — an AURA radio: natively disabled, and the
    // disabled-option reason is the option's own description, so a screen
    // reader hears WHY right after the option's name (AURA 5.26, #125).
    expect(billFirstRadio).toBeDisabled();
    expect(billFirstRadio).toHaveAccessibleName(modeMessages.billFirst.label);
    expect(billFirstRadio).toHaveAccessibleDescription(modeMessages.billFirstNeedsTin);
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
    // The reason is gone: the option is described by its normal hint again
    // (AURA 5.26 describes every option by its own hint), never the reason.
    const enabledBillFirst = screen.getByRole('radio', { name: modeMessages.billFirst.label });
    expect(enabledBillFirst).toHaveAccessibleDescription(/Requires the buyer's tax ID\./);
    expect(enabledBillFirst).not.toHaveAccessibleDescription(modeMessages.billFirstNeedsTin);
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

  it('each mode radio is named by its label, with its hint read after it (AURA RadioGroup)', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    expect(screen.getByTestId('mode-selector')).toBeInTheDocument();
    const radio = screen.getAllByRole('radio')[0]!;
    expect(radio).toHaveAccessibleName(modeMessages.alreadyPaid.label);
    expect(radio).toHaveAccessibleDescription(modeMessages.alreadyPaid.hint);
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

    const dateInput = screen.getByLabelText(new RegExp(`^${enMessages.admin.invoices.pay.fields.date}`));
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

    const dateInput = screen.getByLabelText(new RegExp(`^${enMessages.admin.invoices.pay.fields.date}`));
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
    fireEvent.change(screen.getByLabelText(new RegExp(`^${enMessages.admin.invoices.pay.fields.date}`)), {
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

  it('the submit button carries an icon like the membership form (check when paid now)', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    const submit = screen.getByRole('button', { name: enMessages.admin.invoices.eventFeeForm.recordAndIssue });
    expect(submit.querySelector('svg.aura-icon')).not.toBeNull();
  });

  it('the payment date names its hint and the ภ.พ.30 warning once each (no duplicate describedby ids)', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    const dateInput = screen.getByLabelText(new RegExp(`^${enMessages.admin.invoices.pay.fields.date}`));
    fireEvent.change(dateInput, { target: { value: '2020-01-10' } });
    const ids = (dateInput.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids).toContain('payment-date-vat-warning');
    expect(ids).toContain('payment-date-hint');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("today's payment date → no ภ.พ.30 warning; warning clears when the date returns to an open period", async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));

    const dateInput = screen.getByLabelText(new RegExp(`^${enMessages.admin.invoices.pay.fields.date}`));
    fireEvent.change(dateInput, { target: { value: '2020-01-10' } });
    expect(screen.getByTestId('payment-date-vat-warning')).toBeInTheDocument();

    fireEvent.change(dateInput, { target: { value: bangkokToday() } });
    expect(screen.queryByTestId('payment-date-vat-warning')).toBeNull();
  });
});

/**
 * Spec 122 US8 (T807) — the event-fee form's controls on AURA: the event
 * combobox, the issuance-mode radio group, the payment method select, the
 * amount field, the refunded block and the duplicate dialog.
 */
describe('<EventFeeForm> on AURA (T807)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    pushMock.mockReset();
  });
  afterEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  it('the event picker is an AURA combobox', () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([]));
    renderForm();
    const picker = screen.getByRole('combobox', { name: enMessages.admin.invoices.eventFeeForm.eventPicker.label });
    expect(picker.closest('.aura-field')).not.toBeNull();
  });

  it('the mode choice is an AURA radio group; the as-paid fields are AURA fields', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([matchedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    expect(screen.getByRole('group', { name: modeMessages.label })).toHaveClass('aura-radio-group');
    expect(screen.getByRole('combobox', { name: enMessages.admin.invoices.pay.fields.method })).toBeInTheDocument();
    const method = document.getElementById('payment-method-select') as HTMLSelectElement;
    expect([...method.options].map((o) => o.value)).toEqual(['bank_transfer', 'cheque', 'cash', 'other']);
    expect(screen.getByLabelText(/Amount/).closest('.aura-field')).not.toBeNull();
    expect(screen.getByTestId('doc-type-badge')).toHaveClass('aura-badge');
  });

  it('a refunded registration is blocked by an AURA danger alert', async () => {
    vi.stubGlobal('fetch', mockFetchRegistrations([refundedRegistration]));
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Carol/ }));
    expect(screen.getByTestId('mode-refunded-blocked')).toHaveClass('aura-alert--danger');
  });

  it('the duplicate notice is an AURA dialog', async () => {
    const fetchMock = mockFetchRegistrations([matchedRegistration]);
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ initialEventId: 'ev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: { code: 'duplicate' }, existing_invoice_id: null }), { status: 409 }),
    );
    fireEvent.click(screen.getByRole('button', { name: enMessages.admin.invoices.eventFeeForm.recordAndIssue }));
    const dialog = await screen.findByRole('alertdialog', {
      name: enMessages.admin.invoices.eventFeeForm.duplicateDialog.title,
    });
    expect(dialog).toHaveClass('aura-dialog');
  });
});
