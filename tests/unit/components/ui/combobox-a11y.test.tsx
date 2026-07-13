/**
 * PR-B task 5 — ARIA contract test for the promoted `<Combobox>` primitive.
 *
 * `src/app/(staff)/admin/invoices/_components/searchable-combobox.tsx`
 * (the static-options reference) is missing five of the six ARIA hooks
 * that `src/components/members/member-picker.tsx:254-261` (the ARIA
 * reference, already shipped) carries on its trigger: `aria-expanded`,
 * `aria-haspopup="listbox"`, `aria-controls`, `aria-labelledby`,
 * `aria-describedby`. `searchable-combobox.tsx` also takes an `ariaLabel`
 * prop, which would detach the accessible name from the visible <Label> and
 * break the FieldError + FormErrorSummary wiring the member form depends on
 * — so this contract explicitly asserts `aria-labelledby`, not `ariaLabel`.
 *
 * Renders the REAL `@/components/ui/popover` (Base UI) + `@/components/ui/
 * command` (cmdk) stack — no primitive mocking — so "aria-controls points at
 * the rendered listbox's id" is genuinely verified, not asserted against a
 * stand-in. Two jsdom gotchas this file works around:
 *   1. `tests/setup.ts` installs fake timers globally (for TTL tests
 *      elsewhere); React 19's scheduler needs real ones or state updates
 *      inside the popover's open/close transition never flush. Real timers
 *      are restored in `afterEach` so other files in the same worker are
 *      unaffected.
 *   2. cmdk's `<CommandList>` calls `new ResizeObserver(...)` in a mount
 *      effect, and highlights the selected `<CommandItem>` via
 *      `Element.scrollIntoView(...)`; jsdom implements neither. Trivial
 *      stubs are installed for this file only.
 *
 * `allowCustomValue` contract (a11y re-review, PR-B task 6): `combobox.tsx`
 * gained a creatable-combobox branch and its `CommandInput` became
 * CONTROLLED for every consumer, but this file — the primitive's own ARIA
 * contract — was never updated to pin it; the only coverage lived in
 * `address-section.test.tsx`'s single mouse-click test. `CreatableHarness`
 * below opts into `allowCustomValue`; `Harness` (unchanged, above) stays the
 * `allowCustomValue`-off contract. Fixture strings ("Farmland…") are chosen
 * to contain letters absent from every OPTIONS label (no 'f' in "Thailand"/
 * "Sweden"/"United States") so cmdk's fuzzy filter can never accidentally
 * match them — a flake-proofing trick borrowed from `address-section.
 * test.tsx`'s own "Farmland Province" fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const OPTIONS: readonly ComboboxOption[] = [
  { value: 'TH', label: 'Thailand', group: 'Suggested' },
  { value: 'SE', label: 'Sweden', group: 'Suggested' },
  { value: 'US', label: 'United States', group: 'All countries' },
];

function Harness({
  initial = 'TH',
  onChangeSpy,
}: {
  readonly initial?: string;
  readonly onChangeSpy?: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <label id="country-label" htmlFor="country">
        Country
      </label>
      <Combobox
        id="country"
        options={OPTIONS}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChangeSpy?.(next);
        }}
        placeholder="Select a country…"
        searchPlaceholder="Search countries…"
        emptyMessage="No country found."
        aria-labelledby="country-label"
        aria-describedby="country-help"
        aria-invalid={false}
        aria-required
      />
      <p id="country-help">Helper text</p>
    </div>
  );
}

/** Same fixture, `allowCustomValue` + a translated-shaped label wired on —
 * the shape every real call site (`address-section.tsx`'s province/city/
 * sub_district) actually uses. */
function CreatableHarness({
  initial = 'TH',
  onChangeSpy,
}: {
  readonly initial?: string;
  readonly onChangeSpy?: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <label id="country-label" htmlFor="country">
        Country
      </label>
      <Combobox
        id="country"
        options={OPTIONS}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChangeSpy?.(next);
        }}
        placeholder="Select a country…"
        searchPlaceholder="Search countries…"
        emptyMessage="No country found."
        aria-labelledby="country-label"
        aria-describedby="country-help"
        aria-invalid={false}
        aria-required
        allowCustomValue
        customValueLabel={(typed) => `Use "${typed}"`}
      />
      <p id="country-help">Helper text</p>
    </div>
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

describe('<Combobox> — ARIA contract (closed state)', () => {
  it('trigger carries role=combobox', () => {
    render(<Harness />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('trigger carries aria-haspopup="listbox"', () => {
    render(<Harness />);
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-haspopup', 'listbox');
  });

  it('trigger starts aria-expanded="false"', () => {
    render(<Harness />);
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
  });

  it('trigger has no aria-controls while closed (nothing exists to point at — Base UI unmounts the popup content)', () => {
    render(<Harness />);
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-controls');
  });

  it('trigger carries aria-labelledby pointing at the visible <Label>', () => {
    render(<Harness />);
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-labelledby',
      'country-label',
    );
    expect(screen.getByRole('combobox')).toHaveAccessibleName('Country');
  });

  it('trigger passes through aria-describedby', () => {
    render(<Harness />);
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-describedby',
      'country-help',
    );
  });

  it('trigger passes through aria-invalid', () => {
    render(<Harness />);
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-invalid', 'false');
  });

  it('trigger passes through aria-required', () => {
    render(<Harness />);
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-required', 'true');
  });

  it('does NOT accept an ariaLabel prop that would detach the accessible name from the <Label>', () => {
    // Type-level guard: Combobox's props type has no `ariaLabel` key.
    // @ts-expect-error — ariaLabel must not exist on ComboboxProps.
    const el = <Combobox ariaLabel="nope" />;
    expect(el).toBeTruthy();
  });
});

describe('<Combobox> — ARIA contract (open state)', () => {
  it('clicking the trigger sets aria-expanded="true" and mounts a role=listbox at the id aria-controls names', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
    // cmdk generates the listbox's real id internally (useId()) — it cannot
    // be pre-computed, so wait for the trigger to pick it up off the
    // rendered node rather than asserting a hardcoded string.
    await waitFor(() => expect(trigger.getAttribute('aria-controls')).not.toBeNull());

    const controlsId = trigger.getAttribute('aria-controls');
    const listbox = screen.getByRole('listbox');
    expect(listbox.id).toBe(controlsId);
  });

  it('renders the Suggested + All countries groups with their options', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox'));

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    expect(screen.getByText('Suggested')).toBeInTheDocument();
    expect(screen.getByText('All countries')).toBeInTheDocument();
    expect(screen.getByText('Sweden')).toBeInTheDocument();
    expect(screen.getByText('United States')).toBeInTheDocument();
  });

  it('selecting an option calls onChange and closes the popover', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox'));
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Sweden'));

    await waitFor(() =>
      expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false'),
    );
    expect(screen.getByRole('combobox')).toHaveAccessibleName('Country');
    // The trigger's visible label text swaps to the newly-selected option.
    expect(screen.getByRole('combobox')).toHaveTextContent('Sweden');
  });

  it('Escape closes the popover and returns focus to the trigger', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });

    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe('<Combobox> — allowCustomValue contract (a11y re-review, PR-B task 6)', () => {
  it('the custom item is a real option: role="option", and it takes aria-selected="true" (cmdk\'s getValidItems() is a DOM query, so forceMounted items are in the arrow-key rotation)', async () => {
    render(<CreatableHarness />);
    fireEvent.click(screen.getByRole('combobox'));
    const searchInput = await screen.findByPlaceholderText('Search countries…');

    // "Farmland" fuzzy-matches none of Thailand/Sweden/United States (no
    // 'f' in any of them), so it is the ONLY valid item in the listbox —
    // cmdk auto-highlights the sole remaining item as "selected"
    // (aria-selected) purely by querying the rendered DOM, which is only
    // possible if the forceMounted custom item participates in that query
    // like any other option.
    fireEvent.change(searchInput, { target: { value: 'Farmland' } });

    const customItem = await screen.findByRole('option', { name: 'Use "Farmland"' });
    expect(customItem).toHaveAttribute('role', 'option');
    await waitFor(() => expect(customItem).toHaveAttribute('aria-selected', 'true'));
  });

  it('Enter on the search input commits the typed value — it is not a mouse-only affordance', async () => {
    const onChangeSpy = vi.fn();
    render(<CreatableHarness onChangeSpy={onChangeSpy} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    const searchInput = await screen.findByPlaceholderText('Search countries…');

    fireEvent.change(searchInput, { target: { value: 'Farmland' } });
    await screen.findByRole('option', { name: 'Use "Farmland"' });

    fireEvent.keyDown(searchInput, { key: 'Enter' });

    await waitFor(() => expect(onChangeSpy).toHaveBeenCalledWith('Farmland'));
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });

  it('typing text that exactly equals an existing option\'s value shows no "Use…" item', async () => {
    render(<CreatableHarness />);
    fireEvent.click(screen.getByRole('combobox'));
    const searchInput = await screen.findByPlaceholderText('Search countries…');

    // 'TH' is OPTIONS' own value for Thailand — an exact value match must
    // never offer a redundant "Use "TH"" alongside the real option.
    fireEvent.change(searchInput, { target: { value: 'TH' } });

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Thailand' })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/^Use /)).toBeNull();
  });

  it('with allowCustomValue off (the default), the option set stays closed: emptyMessage renders, and Enter on unmatched text commits nothing', async () => {
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    const searchInput = await screen.findByPlaceholderText('Search countries…');

    fireEvent.change(searchInput, { target: { value: 'Farmland' } });
    await waitFor(() => expect(screen.getByText('No country found.')).toBeInTheDocument());
    expect(screen.queryByRole('option')).toBeNull();

    fireEvent.keyDown(searchInput, { key: 'Enter' });

    expect(onChangeSpy).not.toHaveBeenCalled();
    // Nothing was committed, so the popover never received a close signal.
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});
