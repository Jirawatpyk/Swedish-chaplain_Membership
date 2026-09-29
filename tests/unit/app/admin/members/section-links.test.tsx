/**
 * 122 US5b-1 — the member page's "On this page" links (UX review M3). A link
 * that takes you to a section must also mark that section current and move
 * keyboard focus there, so the next Tab continues inside it (2.4.3) — the
 * observer alone left an earlier tall section current.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SectionLinks } from '@/app/(staff)/admin/members/[memberId]/_components/section-links';

afterEach(cleanup);

const links = [
  { id: 'overview', label: 'Overview' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'invoices', label: 'Invoices' },
];

describe('SectionLinks', () => {
  it('following a link marks it current and focuses its section', () => {
    render(
      <>
        <SectionLinks label="On this page" links={links} />
        {links.map((l) => (
          <section key={l.id} id={l.id} aria-label={l.label}>
            <button type="button">inside {l.label}</button>
          </section>
        ))}
      </>,
    );
    const invoices = screen.getByRole('link', { name: 'Invoices' });
    fireEvent.click(invoices);
    expect(invoices).toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(document.activeElement).toBe(document.getElementById('invoices'));
  });

  // AURA 5.14 (handoff #104, #107): links to sections of this page mark the
  // current one `aria-current="location"`, and the strip sticks under the
  // shell bar at AURA's measured height rather than a fixed 56px.
  it('marks the current section as a location and sticks under the shell bar', () => {
    const { container } = render(<SectionLinks label="On this page" links={links} />);
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'location');
    expect(container.firstElementChild?.className).toContain('top-[var(--aura-shell-bar-height)]');
  });
});
