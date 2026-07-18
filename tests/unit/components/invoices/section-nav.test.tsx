import { render, screen, fireEvent } from '@testing-library/react';
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
    '<section id="organization"><h2 data-section-heading tabindex="-1">Org</h2></section>' +
    '<section id="tax"><h2 data-section-heading tabindex="-1">Tax</h2></section>';
});

it('scrolls to and focuses a section on nav click', () => {
  const scrollSpy = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  HTMLElement.prototype.scrollIntoView = scrollSpy;
  wrap(<SectionNav sections={sections} />);
  fireEvent.click(screen.getByRole('button', { name: /tax/i }));
  expect(scrollSpy).toHaveBeenCalled();
  expect(document.querySelector('#tax [data-section-heading]')).toHaveFocus();
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
  expect(document.querySelector('#tax [data-section-heading]')).toHaveFocus();
});
