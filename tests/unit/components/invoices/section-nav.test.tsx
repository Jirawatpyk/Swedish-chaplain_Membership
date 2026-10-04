/**
 * Spec 122 US8c-2 (T855) — the settings rail on AURA (board
 * `Admin-invoice-settings`): ghost Buttons in the "Settings sections" nav,
 * and below `lg` an AURA Select "Jump to section". A pick scrolls to the
 * section card and moves focus to it (the card is labelled by its heading).
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { SectionNav, type SectionNavItem } from '@/components/invoices/invoice-settings/section-nav';

const sections: readonly SectionNavItem[] = [
  { id: 'organization', labelKey: 'sections.organization' },
  { id: 'tax', labelKey: 'sections.tax' },
];

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

// jsdom has no real IntersectionObserver — SectionNav mounts the real
// useScrollSpy hook (not mocked), so its effect needs a stand-in that
// never actually fires. Mirrors the stub in use-scroll-spy.test.tsx;
// none of these tests depend on scroll-driven active-section updates
// (only the synchronous sections[0] default and the click/change
// handlers), so a no-op observe/disconnect is sufficient.
class NoopIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  (globalThis as unknown as { IntersectionObserver: typeof NoopIntersectionObserver }).IntersectionObserver =
    NoopIntersectionObserver;
  document.body.innerHTML =
    '<section id="organization" tabindex="-1"><h2>Org</h2></section>' +
    '<section id="tax" tabindex="-1"><h2>Tax</h2></section>';
});

it('scrolls to and focuses a section on nav click', async () => {
  const scrollSpy = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  HTMLElement.prototype.scrollIntoView = scrollSpy;
  wrap(<SectionNav sections={sections} />);
  fireEvent.click(screen.getByRole('button', { name: /tax/i }));
  expect(scrollSpy).toHaveBeenCalled();
  await Promise.resolve();
  expect(document.getElementById('tax')).toHaveFocus();
});

// code-review follow-up (finding 5) — the mobile <select> (and the
// desktop nav buttons' aria-current) are controlled by useScrollSpy's
// `active`, which used to only update once the IntersectionObserver
// fired AFTER the smooth-scroll settled — visibly snapping back to the
// previous section right after a click. `goToSection` now calls
// `setActive` synchronously on click, so aria-current must flip
// immediately, with NO IntersectionObserver callback fired at all
// (NoopIntersectionObserver's `observe` never calls back in this suite).
it('optimistically sets aria-current on the clicked nav button, without waiting for a scroll-spy callback', () => {
  const scrollSpy = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  HTMLElement.prototype.scrollIntoView = scrollSpy;
  wrap(<SectionNav sections={sections} />);

  expect(screen.getByRole('button', { name: /tax/i })).not.toHaveAttribute('aria-current');
  fireEvent.click(screen.getByRole('button', { name: /tax/i }));

  expect(screen.getByRole('button', { name: /tax/i })).toHaveAttribute('aria-current', 'location');
  expect(screen.getByRole('button', { name: /org/i })).not.toHaveAttribute('aria-current');
});

it('marks the active section (first, before any scroll spy update) with aria-current', () => {
  wrap(<SectionNav sections={sections} />);
  expect(screen.getByRole('button', { name: /org/i })).toHaveAttribute('aria-current', 'location');
  expect(screen.getByRole('button', { name: /tax/i })).not.toHaveAttribute('aria-current');
});

/** The native `<select>` under AURA's "Jump to section" combobox. */
const jumpSelect = () =>
  screen.getByRole('combobox', { name: /jump to section/i }).closest('.aura-select')!.querySelector('select')!;

it('renders a labelled mobile jump-to select with an option per section', () => {
  wrap(<SectionNav sections={sections} />);
  const select = jumpSelect();
  expect(select).toBeInstanceOf(HTMLSelectElement);
  expect([...select.options].map((o) => o.value)).toEqual(['organization', 'tax']);
});

it('scrolls to and focuses a section when the mobile select changes', async () => {
  const scrollSpy = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  HTMLElement.prototype.scrollIntoView = scrollSpy;
  wrap(<SectionNav sections={sections} />);
  fireEvent.change(jumpSelect(), { target: { value: 'tax' } });
  expect(scrollSpy).toHaveBeenCalled();
  await Promise.resolve();
  expect(document.getElementById('tax')).toHaveFocus();
});

it('renders the rail as AURA ghost buttons in the "Settings sections" nav, hidden below xl', () => {
  wrap(<SectionNav sections={sections} />);
  const nav = screen.getByRole('navigation', { name: 'Settings sections' });
  expect(nav).toHaveClass('max-xl:hidden');
  const buttons = within(nav).getAllByRole('button');
  expect(buttons).toHaveLength(2);
  for (const b of buttons) expect(b).toHaveClass('aura-btn', 'aura-btn--ghost', 'min-h-11');
});

it('below xl the jump-to select is an AURA Select (44px) with a visible label', () => {
  wrap(<SectionNav sections={sections} />);
  const select = jumpSelect();
  expect(select.closest('.aura-input.aura-select')).not.toBeNull();
  expect(select.closest('.is-touch-always')).not.toBeNull();
  expect(select.closest('.xl\\:hidden')).not.toBeNull();
  // UX review L4: a visible label, so it doesn't read as a settings field.
  expect(screen.getByText('Jump to section…').closest('label')).not.toBeNull();
});

// UX review H1: picking from AURA's own list closes it and returns focus to
// the combobox; the section must still end up focused.
it('a pick from the AURA list moves focus to the section', async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  wrap(<SectionNav sections={sections} />);
  // AURA's `choose()` (Select.js) fires the native change, then `close(true)`
  // focuses the combobox again. jsdom can't run its option click (setting
  // the native value throws there), so replay that sequence directly.
  const combobox = screen.getByRole('combobox', { name: /jump to section/i });
  fireEvent.change(jumpSelect(), { target: { value: 'tax' } });
  combobox.focus();
  await Promise.resolve();
  expect(document.getElementById('tax')).toHaveFocus();
});
