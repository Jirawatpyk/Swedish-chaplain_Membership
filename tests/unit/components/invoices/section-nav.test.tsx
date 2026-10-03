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

it('scrolls to and focuses a section on nav click', () => {
  const scrollSpy = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  HTMLElement.prototype.scrollIntoView = scrollSpy;
  wrap(<SectionNav sections={sections} />);
  fireEvent.click(screen.getByRole('button', { name: /tax/i }));
  expect(scrollSpy).toHaveBeenCalled();
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

it('renders a labelled mobile jump-to select with an option per section', () => {
  wrap(<SectionNav sections={sections} />);
  const select = screen.getByLabelText(/jump to section/i);
  expect(select).toBeInstanceOf(HTMLSelectElement);
  const options = screen.getAllByRole('option');
  expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['organization', 'tax']);
});

it('scrolls to and focuses a section when the mobile select changes', () => {
  const scrollSpy = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  HTMLElement.prototype.scrollIntoView = scrollSpy;
  wrap(<SectionNav sections={sections} />);
  fireEvent.change(screen.getByLabelText(/jump to section/i), { target: { value: 'tax' } });
  expect(scrollSpy).toHaveBeenCalled();
  expect(document.getElementById('tax')).toHaveFocus();
});

it('renders the rail as AURA ghost buttons in the "Settings sections" nav, hidden below lg', () => {
  wrap(<SectionNav sections={sections} />);
  const nav = screen.getByRole('navigation', { name: 'Settings sections' });
  expect(nav).toHaveClass('max-lg:hidden');
  const buttons = within(nav).getAllByRole('button');
  expect(buttons).toHaveLength(2);
  for (const b of buttons) expect(b).toHaveClass('aura-btn', 'aura-btn--ghost', 'min-h-11');
});

it('below lg the jump-to select is an AURA Select (44px)', () => {
  wrap(<SectionNav sections={sections} />);
  const select = screen.getByLabelText(/jump to section/i);
  expect(select.closest('.aura-input.aura-select')).not.toBeNull();
  expect(select.closest('.is-touch-always')).not.toBeNull();
  expect(select.closest('.lg\\:hidden')).not.toBeNull();
});
