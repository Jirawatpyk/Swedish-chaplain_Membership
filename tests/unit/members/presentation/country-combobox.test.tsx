/**
 * PR-B task 5 — <CountryCombobox> unit tests.
 *
 * Renders against the REAL `i18n-iso-countries` module (no mock) — the EN
 * locale is eager-registered as a module-load side effect in
 * `country-display.tsx` (round-11 fix, see `country-display-en-ssr.test.tsx`
 * for the sibling contract on `<CountryDisplay>`), so `getNames('en')`
 * resolves synchronously on first render for locale="en" and this suite
 * never races the dynamic per-locale import.
 *
 * Same jsdom workarounds as `combobox-a11y.test.tsx` (real timers,
 * ResizeObserver + scrollIntoView stubs) since this opens the real
 * Popover + cmdk stack, not a mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import enMessages from '@/i18n/messages/en.json';
import { CountryCombobox } from '@/components/members/country-combobox';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function Harness({ initial = 'TH' }: { readonly initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <label id="country-label" htmlFor="country">
        Country
      </label>
      <CountryCombobox
        id="country"
        value={value}
        onChange={setValue}
        aria-labelledby="country-label"
        aria-describedby="country-help"
        aria-invalid={false}
      />
      <p id="country-help">Helper text</p>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useFakeTimers({
    now: new Date('2026-04-09T12:00:00.000Z'),
    shouldAdvanceTime: false,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
});

describe('<CountryCombobox>', () => {
  it('renders a trigger labelled by the external <Label>', () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveAttribute('aria-labelledby', 'country-label');
    expect(trigger).toHaveAccessibleName('Country');
  });

  it('shows the localised EN name for the default value ("TH" → "Thailand")', () => {
    render(<Harness />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Thailand');
  });

  it('resolves a lowercase stored value to its uppercase option ("se" → "Sweden")', () => {
    render(<Harness initial="se" />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Sweden');
  });

  it('passes through aria-describedby and aria-invalid', () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveAttribute('aria-describedby', 'country-help');
    expect(trigger).toHaveAttribute('aria-invalid', 'false');
  });

  it('opening the popover shows a Suggested group with Thailand + Sweden, and an All countries group with the rest', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox'));

    const listbox = await screen.findByRole('listbox');
    const suggestedHeading = within(listbox).getByText('Suggested');
    expect(suggestedHeading).toBeInTheDocument();
    expect(within(listbox).getByText('All countries')).toBeInTheDocument();

    // cmdk marks each group's OUTER wrapper `role="presentation"` (removed
    // from the a11y tree, not queryable via getByRole('group')) — walk up
    // from the heading text to the `[cmdk-group]` container cmdk documents
    // as its own stable public selector (same one `combobox.tsx` reads the
    // listbox id off of).
    const suggestedGroup = suggestedHeading.closest('[cmdk-group]');
    expect(suggestedGroup).not.toBeNull();
    expect(within(suggestedGroup as HTMLElement).getByText('Thailand')).toBeInTheDocument();
    expect(within(suggestedGroup as HTMLElement).getByText('Sweden')).toBeInTheDocument();

    // A non-pinned country (the US — i18n-iso-countries' official EN name
    // is "United States of America") is reachable but lives in the "All
    // countries" group, not "Suggested" — the whole point of this task (a
    // 3-value dropdown would make it unrepresentable at all).
    expect(
      within(suggestedGroup as HTMLElement).queryByText('United States of America'),
    ).toBeNull();
    expect(within(listbox).getByText('United States of America')).toBeInTheDocument();
  });

  it('selecting a country calls onChange with the uppercase alpha-2 code, not the label', async () => {
    const onChange = vi.fn();
    function ControlledHarness() {
      const [value, setValue] = useState('TH');
      return (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <label id="country-label" htmlFor="country">
            Country
          </label>
          <CountryCombobox
            id="country"
            value={value}
            onChange={(next) => {
              onChange(next);
              setValue(next);
            }}
            aria-labelledby="country-label"
          />
        </NextIntlClientProvider>
      );
    }
    render(<ControlledHarness />);
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByText('Sweden'));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('SE'));
    await waitFor(() =>
      expect(screen.getByRole('combobox')).toHaveTextContent('Sweden'),
    );
  });

  it('the search box filters by the localised label (e.g. "Sweden" narrows to SE)', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    const search = screen.getByPlaceholderText('Search countries…');

    fireEvent.change(search, { target: { value: 'Sweden' } });

    await waitFor(() => {
      expect(within(listbox).getByText('Sweden')).toBeInTheDocument();
      expect(within(listbox).queryByText('United States of America')).toBeNull();
    });
  });
});
