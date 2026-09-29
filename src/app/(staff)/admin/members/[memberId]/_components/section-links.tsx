'use client';

/**
 * 122 US5b-1 (T553) — the member detail page's "On this page" links (board
 * `Admin-member-detail`; Clarifications, Session 2026-09-28: the board's tab
 * row becomes in-page links and every card stays on the page).
 *
 * AURA `Tabs` with an `href` on every tab renders a `nav` of links with the
 * current one marked. Sticky under AURA's shell bar (its 56 px minimum
 * height; the bar has no height token), scrolling sideways on a phone. The
 * page lists only the sections this viewer has.
 *
 * "Current" is the last section whose top has passed under the bar, or the
 * last section once the page is scrolled to its end (a short final section
 * never reaches the bar). Following a link marks it at once and moves focus
 * into that section, so the next Tab continues there (UX review M3, 2.4.3).
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { Tabs } from '@jirawatpyk/aura-react';

export interface SectionLink {
  readonly id: string;
  readonly label: string;
}

/** Below the shell bar and this row (the sections' `scroll-mt-28`, 112 px). */
const BAND_TOP_PX = 120;

function sectionInView(links: readonly SectionLink[]): string | undefined {
  const doc = document.documentElement;
  if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) return links.at(-1)?.id;
  let current = links[0]?.id;
  for (const l of links) {
    const el = document.getElementById(l.id);
    if (el && el.getBoundingClientRect().top <= BAND_TOP_PX) current = l.id;
  }
  return current;
}

export function SectionLinks({ label, links }: { readonly label: string; readonly links: readonly SectionLink[] }) {
  const [current, setCurrent] = useState(links[0]?.id);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const id = sectionInView(links);
        if (id) setCurrent(id);
      });
    };
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [links]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
    const id = anchor?.getAttribute('href')?.slice(1);
    const section = id ? document.getElementById(id) : null;
    if (!id || !section) return;
    setCurrent(id);
    // The browser scrolls to the anchor; focus follows without a second jump.
    if (!section.hasAttribute('tabindex')) section.setAttribute('tabindex', '-1');
    section.focus({ preventScroll: true });
  };

  return (
    <div
      className="sticky top-14 z-[5] -mx-[var(--page-padding-x)] bg-[var(--aura-bg-canvas)] px-[var(--page-padding-x)]"
      onClick={onClick}
    >
      <Tabs
        label={label}
        value={current}
        tabs={links.map((l) => ({ id: l.id, label: l.label, href: `#${l.id}` }))}
      />
    </div>
  );
}
