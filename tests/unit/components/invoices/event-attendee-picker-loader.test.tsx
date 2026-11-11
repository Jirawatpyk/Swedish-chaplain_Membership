/**
 * #82 — the attendee picker reads every page of an event's registrations
 * (the route pages at 200), so an attendee past the first 200 — or a
 * deep-linked one — is listed, and a list cut at the load cap says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  ATTENDEE_LOAD_CAP,
  ATTENDEE_PAGE_SIZE,
  EventAttendeePickerLoader,
} from '@/app/(staff)/admin/invoices/new/_components/event-attendee-picker';

const row = (i: number) => ({
  registrationId: `reg-${i}`,
  attendeeName: `Attendee ${i}`,
  attendeeCompany: null,
  matchType: 'non_member',
  matchedMemberId: null,
  ticketPriceThb: 500,
  paymentStatus: 'paid',
  isPseudonymised: false,
});

function stubPages(total: number, failPages: ReadonlySet<number> = new Set()) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://app.test');
    const page = Number(url.searchParams.get('page') ?? '1');
    if (failPages.has(page)) return new Response('{}', { status: 500 });
    const size = Number(url.searchParams.get('pageSize') ?? '50');
    const from = (page - 1) * size;
    const rows = Array.from({ length: Math.max(0, Math.min(size, total - from)) }, (_, k) => row(from + k));
    return new Response(JSON.stringify({ registrations: rows, pagination: { page, pageSize: size, totalCount: total } }), {
      status: 200,
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderLoader(selected: string | null = null, onSelect = vi.fn()) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <EventAttendeePickerLoader
        eventId="ev-1"
        selectedRegistrationId={selected}
        autoSelectRegistrationId={selected}
        onSelect={onSelect}
      />
    </NextIntlClientProvider>,
  );
}
const picker = enMessages.admin.invoices.eventFeeForm.attendeePicker;

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe('EventAttendeePickerLoader reads past the first page (#82)', () => {
  it('a 250-attendee event lists all 250, and a deep-linked attendee on page 2 is picked once', async () => {
    const fn = stubPages(250);
    const onSelect = vi.fn();
    renderLoader('reg-230', onSelect);
    await waitFor(() => expect(document.querySelectorAll('li > button').length).toBe(250), { timeout: 3000 });
    expect(fn.mock.calls.map((c) => new URL(String(c[0]), 'https://app.test').searchParams.get('page'))).toEqual(['1', '2']);
    expect(document.querySelector('button[aria-pressed="true"]')?.getAttribute('aria-label')).toMatch(/^Attendee 230,/);
    expect(screen.queryByTestId('attendee-picker-cut')).toBeNull();
    // UX M3 — the deep link fills the form, not only the highlight.
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ registrationId: 'reg-230' });
  });

  it('a failed later page drops only its rows, and the list says it is cut', async () => {
    stubPages(450, new Set([2]));
    renderLoader();
    expect(await screen.findByTestId('attendee-picker-cut', {}, { timeout: 3000 })).toHaveTextContent(
      'Showing 250 of 450 attendees.',
    );
    expect(document.querySelectorAll('li > button').length).toBe(250);
    expect(screen.getByRole('list').getAttribute('aria-describedby')).toBe(
      screen.getByTestId('attendee-picker-cut').id,
    );
  });

  it('a failed first page shows an error with Try again, which reloads', async () => {
    const fn = stubPages(30, new Set([1]));
    renderLoader();
    expect(await screen.findByText(picker.loadFailedTitle, {}, { timeout: 3000 })).toBeInTheDocument();
    vi.unstubAllGlobals();
    stubPages(30);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(document.querySelectorAll('li > button').length).toBe(30), { timeout: 3000 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('past the load cap, it reads only up to the cap and says the list is cut', async () => {
    const fn = stubPages(ATTENDEE_LOAD_CAP + 5);
    renderLoader();
    expect(await screen.findByTestId('attendee-picker-cut', {}, { timeout: 5000 })).toHaveTextContent(
      `Showing ${ATTENDEE_LOAD_CAP} of ${ATTENDEE_LOAD_CAP + 5} attendees.`,
    );
    expect(fn).toHaveBeenCalledTimes(ATTENDEE_LOAD_CAP / ATTENDEE_PAGE_SIZE);
  });
});
