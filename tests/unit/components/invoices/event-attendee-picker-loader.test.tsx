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

// #89 — a filter above a long attendee list, and a word when a deep link's
// registration is not in the list.
describe('EventAttendeePickerLoader filter and deep-link note (#89)', () => {
  const filterLabel = () => picker.filter?.label ?? '<missing attendeePicker.filter.label>';

  it('a list of 20 or fewer has no filter', async () => {
    stubPages(20);
    renderLoader();
    await waitFor(() => expect(document.querySelectorAll('li > button').length).toBe(20), { timeout: 3000 });
    expect(screen.queryByRole('searchbox', { name: filterLabel() })).toBeNull();
  });

  it('filters a longer list by name, keeps the picked row, says the count, and says when nothing matches', async () => {
    stubPages(30);
    renderLoader('reg-5');
    const box = await screen.findByRole('searchbox', { name: filterLabel() }, { timeout: 3000 });
    fireEvent.change(box, { target: { value: 'attendee 2' } });
    // "Attendee 2" and "Attendee 20".."Attendee 29", plus the picked "Attendee 5".
    const names = [...document.querySelectorAll('li > button')].map((b) => b.getAttribute('aria-label')?.split(',')[0]);
    expect(names).toContain('Attendee 5');
    expect(names.filter((n) => n !== 'Attendee 5')).toHaveLength(11);
    // The announced count is the matches (11), not the pinned row.
    expect(document.body).toHaveTextContent('11 of 30 attendees');
    fireEvent.change(box, { target: { value: 'zzz-nobody' } });
    expect(screen.getAllByText(picker.filter?.noMatch ?? '<missing attendeePicker.filter.noMatch>').length).toBeGreaterThan(0);
    fireEvent.change(box, { target: { value: '' } });
    expect(document.querySelectorAll('li > button').length).toBe(30);
  });

  it('says when the linked registration is not in this event\'s list', async () => {
    stubPages(10);
    renderLoader('reg-not-here');
    expect(
      await screen.findByText(picker.linkNotFound ?? '<missing attendeePicker.linkNotFound>', {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  it('says nothing when the linked registration is listed', async () => {
    stubPages(10);
    renderLoader('reg-3');
    await waitFor(() => expect(document.querySelectorAll('li > button').length).toBe(10), { timeout: 3000 });
    expect(screen.queryByText(picker.linkNotFound ?? '<missing attendeePicker.linkNotFound>')).toBeNull();
  });

  // #89 review (a11y H1) — the filter sits inside the event-fee form; Enter in
  // it must not submit the form (which can issue a tax document as paid).
  it('Enter in the filter does not submit the surrounding form', async () => {
    stubPages(30);
    renderLoader();
    const box = await screen.findByRole('searchbox', { name: filterLabel() }, { timeout: 3000 });
    // fireEvent returns false when a handler called preventDefault().
    expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(false);
  });

  // #89 review (a11y M1 / UX M1) — the announced count is the matches, and a
  // filter matching nobody says so in the live region, even with a row pinned.
  it('announces the match count, not the pinned row, and "No attendees match" in the live region', async () => {
    stubPages(30);
    renderLoader('reg-5');
    const box = await screen.findByRole('searchbox', { name: filterLabel() }, { timeout: 3000 });
    fireEvent.change(box, { target: { value: 'zzz-nobody' } });
    const statuses = screen.getAllByRole('status').map((s) => s.textContent);
    expect(statuses).toContain(picker.filter?.noMatch);
    expect(statuses.join(' ')).not.toMatch(/1 of 30/);
  });
});

