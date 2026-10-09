/**
 * Spec 122 US9b-2 (T932) — the CSV import's event picker on AURA
 * `Combobox`. Behaviour is unchanged from the cmdk picker: the field is
 * named by its visible label, typing filters the events locally, the
 * filename suggestion selects a strong match when nothing is chosen, and
 * an event created inline survives a slower fetch of the events list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import {
  EventPicker,
  type EventPickerOption,
} from '@/components/events/event-picker';
import enMessages from '@/i18n/messages/en.json';
import { buildFormats } from '@/i18n/formats';

const AGM: EventPickerOption = {
  eventId: 'ev-agm',
  name: 'SweCham AGM 2026',
  startDate: '2026-03-15T06:00:00.000Z',
};
const GALA: EventPickerOption = {
  eventId: 'ev-gala',
  name: 'Midsummer Gala',
  startDate: '2026-06-20T11:00:00.000Z',
};

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      formats={buildFormats('en')}
      timeZone="Asia/Bangkok"
    >
      {node}
    </NextIntlClientProvider>
  );
}

function Harness(props: {
  readonly events?: ReadonlyArray<EventPickerOption>;
  readonly filenameHint?: string | null;
  readonly onChange?: (id: string | null) => void;
  readonly onRegister?: (add: (e: EventPickerOption) => void) => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <EventPicker
      label="Event"
      value={value}
      onChange={(id) => {
        setValue(id);
        props.onChange?.(id);
      }}
      {...(props.events !== undefined ? { events: props.events } : {})}
      filenameHint={props.filenameHint ?? null}
      onCreateNew={() => {}}
      {...(props.onRegister !== undefined
        ? { registerAddEvent: props.onRegister }
        : {})}
    />
  );
}

describe('EventPicker on AURA Combobox (US9b-2)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it('is a combobox named by its label; typing filters and picking selects', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(wrap(<Harness events={[AGM, GALA]} onChange={onChange} />));

    const field = screen.getByRole('combobox', { name: 'Event' });
    await user.click(field);
    await user.type(field, 'gala');
    const listbox = await screen.findByRole('listbox');
    expect(
      within(listbox).queryByRole('option', { name: /SweCham AGM/ }),
    ).not.toBeInTheDocument();
    await user.click(
      within(listbox).getByRole('option', { name: /Midsummer Gala/ }),
    );
    expect(onChange).toHaveBeenLastCalledWith('ev-gala');
    // The closed field shows the event with its date.
    await waitFor(() =>
      expect((field as HTMLInputElement).value).toMatch(/^Midsummer Gala — /),
    );
  });

  it('marks the field required and puts the refresh button beside it (board)', () => {
    render(wrap(<Harness events={[AGM, GALA]} />));
    const field = screen.getByRole('combobox', { name: /Event/ });
    expect(field).toBeRequired();
    const row = screen.getByTestId('event-picker-field-row');
    expect(row).toContainElement(field);
    expect(
      within(row).getByRole('button', {
        name: enMessages.admin.events.import.eventPicker.refreshAriaLabel,
      }),
    ).toBeInTheDocument();
  });

  it('selects the filename suggestion when nothing is chosen', async () => {
    const onChange = vi.fn();
    render(
      wrap(
        <Harness
          events={[AGM, GALA]}
          filenameHint="swecham-agm-2026.csv"
          onChange={onChange}
        />,
      ),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('ev-agm'));
    expect(
      await screen.findByText(/Auto-suggested from filename: SweCham AGM 2026/),
    ).toBeInTheDocument();
  });

  it('keeps an inline-created event when the events fetch resolves later', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    let add: (e: EventPickerOption) => void = () => {};
    const user = userEvent.setup();
    render(wrap(<Harness onRegister={(fn) => (add = fn)} />));

    const created: EventPickerOption = {
      eventId: 'ev-new',
      name: 'Brand New Mixer',
      startDate: '2026-11-20T11:30:00.000Z',
    };
    act(() => add(created));

    // The slow fetch lands with a list that does not include the new event.
    await act(async () => {
      resolveFetch(
        new Response(JSON.stringify({ items: [AGM] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    const field = screen.getByRole('combobox', { name: 'Event' });
    await user.click(field);
    const listbox = await screen.findByRole('listbox');
    expect(
      within(listbox).getByRole('option', { name: /Brand New Mixer/ }),
    ).toBeInTheDocument();
    expect(
      within(listbox).getByRole('option', { name: /SweCham AGM 2026/ }),
    ).toBeInTheDocument();
  });

  it('shows a failed events load on the field without opening it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(wrap(<Harness />));
    const field = screen.getByRole('combobox', { name: 'Event' });
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(
      screen.getByText(enMessages.admin.events.import.eventPicker.loadErrorDetail),
    ).toBeVisible();
  });
});

