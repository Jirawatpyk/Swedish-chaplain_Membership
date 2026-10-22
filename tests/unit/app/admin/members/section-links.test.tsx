/**
 * 122 US5b-1 — the member page's "On this page" links (UX review M3). A link
 * that takes you to a section must also mark that section current and move
 * keyboard focus there, so the next Tab continues inside it (2.4.3) — the
 * observer alone left an earlier tall section current.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

// Layout B (two columns): the current section is the one whose top most
// recently passed under the tabs, by position on the page, not by the
// links' order (the aside's Company passes the band before the main
// column's Timeline). A followed link stays current through the scroll it
// starts, even at the end of the page.
describe('SectionLinks scroll-spy in two columns', () => {
  const twoColumn = [
    { id: 'contacts', label: 'Contacts' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'company', label: 'Company' },
    { id: 'data-export', label: 'Data export' },
  ];
  const tops: Record<string, number> = { contacts: -600, timeline: 60, company: -200, 'data-export': 400 };

  function renderAt(scrollHeight: number) {
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: scrollHeight, configurable: true });
    const utils = render(
      <>
        <SectionLinks label="On this page" links={twoColumn} />
        {twoColumn.map((l) => (
          <section key={l.id} id={l.id} aria-label={l.label} />
        ))}
      </>,
    );
    for (const l of twoColumn) {
      document.getElementById(l.id)!.getBoundingClientRect = () => ({ top: tops[l.id]! }) as DOMRect;
    }
    (utils.container.firstElementChild as HTMLElement).getBoundingClientRect = () => ({ bottom: 100 }) as DOMRect;
    return utils;
  }
  // The spy runs on the next animation frame (setTimeout is faked here, so
  // run frames at once).
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const frame = () => act(async () => {});

  it('marks the section that most recently passed the tabs, by position', async () => {
    renderAt(10_000);
    fireEvent.scroll(window);
    await frame();
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'location');
  });

  it('keeps a followed link current through its own scroll, even at the end of the page', async () => {
    renderAt(0); // already at the end
    fireEvent.click(screen.getByRole('link', { name: 'Timeline' }));
    fireEvent.scroll(window);
    await frame();
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'location');
  });

  // UX review H1: from 1024px the aside's Company passes the tabs while the
  // reader is still in the main column, so aside sections are left out of the
  // spy there (a followed link to one still marks it).
  it('from lg, an aside section does not take over while the main column is read', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('1024'), media: q, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 10_000, configurable: true });
    const links = [
      { id: 'contacts', label: 'Contacts' },
      { id: 'invoices', label: 'Invoices' },
      { id: 'company', label: 'Company', aside: true },
    ];
    const at: Record<string, number> = { contacts: -600, invoices: 300, company: -50 };
    const { container } = render(
      <>
        <SectionLinks label="On this page" links={links} />
        {links.map((l) => (
          <section key={l.id} id={l.id} aria-label={l.label} />
        ))}
      </>,
    );
    for (const l of links) document.getElementById(l.id)!.getBoundingClientRect = () => ({ top: at[l.id]! }) as DOMRect;
    (container.firstElementChild as HTMLElement).getBoundingClientRect = () => ({ bottom: 100 }) as DOMRect;
    fireEvent.scroll(window);
    await frame();
    expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute('aria-current', 'location');
  });
});
