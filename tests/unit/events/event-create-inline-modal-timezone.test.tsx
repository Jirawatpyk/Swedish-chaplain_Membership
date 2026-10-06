/**
 * EventCreateInlineModal — the start date is the chamber's wall time (spec 122
 * clarification 2026-10-06: fixed in its own PR before US9b).
 *
 * `<input type="datetime-local">` gives a naive `YYYY-MM-DDTHH:mm`. The help
 * text promises the tenant's timezone (Asia/Bangkok for every tenant today, as
 * on the import history and the F7 schedulers), so the POSTed instant must not
 * depend on the browser's timezone. Expected values are fixed UTC instants:
 * this goes RED on any runner whose TZ is not UTC+7 (CI and this container run
 * UTC) while the conversion uses `new Date(local)`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { EventCreateInlineModal } from '@/components/events/event-create-inline-modal';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const fetchMock = vi.fn();

beforeEach(() => {
  // tests/setup.ts fakes setTimeout; waitFor polls on it.
  vi.useRealTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ title: 'stub' }), { status: 500 }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function submitWithStart(local: string): Promise<Record<string, unknown>> {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <EventCreateInlineModal open onOpenChange={vi.fn()} />
    </NextIntlClientProvider>,
  );
  fireEvent.change(screen.getByLabelText('External ID'), { target: { value: 'midsummer-2026' } });
  fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'Midsummer' } });
  fireEvent.change(screen.getByLabelText('Start date & time'), { target: { value: local } });
  const form = document.querySelector('form');
  if (!form) throw new Error('event modal form did not render');
  fireEvent.submit(form);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('EventCreateInlineModal start date', () => {
  it('posts the typed wall time as Bangkok time, whatever the browser timezone', async () => {
    const body = await submitWithStart('2026-11-20T18:30');
    expect(body['startDate']).toBe('2026-11-20T11:30:00.000Z');
  });

  it('keeps the Bangkok calendar day for an early-morning start', async () => {
    const body = await submitWithStart('2026-01-01T05:00');
    expect(body['startDate']).toBe('2025-12-31T22:00:00.000Z');
  });
});
