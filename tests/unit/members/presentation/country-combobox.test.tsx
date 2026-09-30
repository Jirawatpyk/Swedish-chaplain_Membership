/**
 * PR-B task 5 — <CountryCombobox> unit tests; spec 122 US5b-2 (T574): on AURA
 * `Combobox`, the "Suggested" group (TH, SE) through `groups`.
 *
 * Renders against the REAL `i18n-iso-countries` module (no mock) — the EN
 * locale is eager-registered as a module-load side effect in
 * `country-display.tsx` (round-11 fix, see `country-display-en-ssr.test.tsx`
 * for the sibling contract on `<CountryDisplay>`), so `getNames('en')`
 * resolves synchronously on first render for locale="en" and this suite
 * never races the dynamic per-locale import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import enMessages from '@/i18n/messages/en.json';
import { CountryCombobox } from '@/components/members/country-combobox';

function Harness({
  initial = 'TH',
  onChange,
  error,
}: {
  readonly initial?: string;
  readonly onChange?: (next: string) => void;
  readonly error?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CountryCombobox
        id="country"
        label="Country"
        required
        value={value}
        onChange={(next) => {
          onChange?.(next);
          setValue(next);
        }}
        {...(error ? { error } : {})}
      />
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  vi.useRealTimers();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useFakeTimers({
    now: new Date('2026-04-09T12:00:00.000Z'),
    shouldAdvanceTime: false,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
});

describe('<CountryCombobox> (AURA)', () => {
  it('is an AURA combobox named by its own label, required, showing the localised name', () => {
    const { container } = render(<Harness />);
    const input = screen.getByRole('combobox', { name: /country/i });
    expect(input).toHaveValue('Thailand');
    expect(input).toBeRequired();
    expect(container.querySelector('label[for="country"]')?.textContent).toContain('*');
  });

  it('resolves a lowercase stored value to its uppercase option ("se" → "Sweden")', () => {
    render(<Harness initial="se" />);
    expect(screen.getByRole('combobox', { name: /country/i })).toHaveValue('Sweden');
  });

  it('shows an error under the field and marks the input invalid', () => {
    render(<Harness error="Pick a country" />);
    const input = screen.getByRole('combobox', { name: /country/i });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'country-error');
    expect(document.getElementById('country-error')).toHaveTextContent('Pick a country');
  });

  it('lists Thailand and Sweden under "Suggested", every other country under "All countries"', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: /country/i }));
    const listbox = await screen.findByRole('listbox');
    const suggested = within(listbox).getByRole('group', { name: 'Suggested' });
    expect(within(suggested).getAllByRole('option').map((o) => o.textContent)).toEqual(['Thailand', 'Sweden']);
    const all = within(listbox).getByRole('group', { name: 'All countries' });
    expect(within(all).getByRole('option', { name: 'United States of America' })).toBeInTheDocument();
    expect(within(suggested).queryByRole('option', { name: 'United States of America' })).toBeNull();
  });

  it('selecting a country reports the uppercase alpha-2 code, not the label', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: /country/i }));
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: 'Sweden' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('SE'));
    expect(screen.getByRole('combobox', { name: /country/i })).toHaveValue('Sweden');
  });

  it('typing filters by the localised name and by the ISO code', async () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: /country/i });
    fireEvent.change(input, { target: { value: 'Swed' } });
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'Sweden' })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: 'United States of America' })).toBeNull();
    fireEvent.change(input, { target: { value: 'US' } });
    await waitFor(() =>
      expect(within(screen.getByRole('listbox')).getByRole('option', { name: 'United States of America' })).toBeInTheDocument(),
    );
  });
});
