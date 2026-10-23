'use client';

/**
 * 122 US5b-1 (T553) — the member detail page's "On this page" links (board
 * `Admin-member-detail`; Clarifications, Session 2026-09-28: the board's tab
 * row becomes in-page links and every card stays on the page).
 *
 * AURA `Tabs` with an `href` on every tab renders a `nav` of links with the
 * current one marked `aria-current="location"` (links to sections of this
 * page, AURA 5.14). Sticky under AURA's shell bar at its measured height
 * (`--aura-shell-bar-height`), scrolling sideways on a phone. The page lists
 * only the sections this viewer has.
 *
 * "Current" is the last section whose top has passed under the bar, or the
 * last section once the page is scrolled to its end (a short final section
 * never reaches the bar). Following a link marks it at once and moves focus
 * into that section, so the next Tab continues there (UX review M3, 2.4.3).
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Tabs } from '@jirawatpyk/aura-react';
import { useSectionTabsScrollPadding } from '@/hooks/use-section-tabs-scroll-padding';

export interface SectionLink {
  readonly id: string;
  readonly label: string;
  /**
   * In the page's aside from lg: left out of the scroll-spy there, since it
   * passes the tabs while the main column is still being read. A followed
   * link to it still marks it.
   */
  readonly aside?: boolean;
}

/** Where the member page splits into two columns (Tailwind `lg`). */
const TWO_COLUMNS = '(min-width: 1024px)';

/** A section counts as reached a little below this row's bottom edge. */
const BAND_SLACK_PX = 8;

/**
 * The section whose top most recently passed the band, by position, not by
 * the links' order. In two columns only the main column's sections count.
 * At the end of the page, the lowest section (a short final section never
 * reaches the band).
 */
function sectionInView(links: readonly SectionLink[], bandTop: number): string | undefined {
  const doc = document.documentElement;
  const atEnd = window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
  const twoColumns = typeof window.matchMedia === 'function' && window.matchMedia(TWO_COLUMNS).matches;
  let current: string | undefined;
  let best = -Infinity;
  for (const l of links) {
    if (twoColumns && l.aside) continue;
    const top = document.getElementById(l.id)?.getBoundingClientRect().top;
    if (top === undefined || (!atEnd && top > bandTop)) continue;
    if (top > best) {
      best = top;
      current = l.id;
    }
  }
  return current ?? links[0]?.id;
}

export function SectionLinks({ label, links }: { readonly label: string; readonly links: readonly SectionLink[] }) {
  const [current, setCurrent] = useState(links[0]?.id);
  const rowRef = useRef<HTMLDivElement>(null);
  // A followed link stays current through the scroll it starts, until the
  // user scrolls on their own (wheel, touch or a key).
  const followedRef = useRef<string | null>(null);
  // The row's height feeds `scroll-padding-top`, so an anchored section lands
  // below the shell bar and this row at any width, locale or zoom.
  useSectionTabsScrollPadding(rowRef);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (followedRef.current) return;
        // Where an anchored section lands: `scroll-padding-top` (the shell
        // bar, this row and a gap), else just below this row.
        const padding = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop);
        const rowBottom = rowRef.current?.getBoundingClientRect().bottom ?? 0;
        const bandTop = Number.isFinite(padding) ? padding + 1 : rowBottom + BAND_SLACK_PX;
        const id = sectionInView(links, bandTop);
        if (id) setCurrent(id);
      });
    };
    const release = () => {
      followedRef.current = null;
    };
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchstart', release, { passive: true });
    window.addEventListener('keydown', release);
    update();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('wheel', release);
      window.removeEventListener('touchstart', release);
      window.removeEventListener('keydown', release);
    };
  }, [links]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
    const id = anchor?.getAttribute('href')?.slice(1);
    const section = id ? document.getElementById(id) : null;
    if (!id || !section) return;
    followedRef.current = id;
    setCurrent(id);
    // The browser scrolls to the anchor; focus follows without a second jump.
    if (!section.hasAttribute('tabindex')) section.setAttribute('tabindex', '-1');
    section.focus({ preventScroll: true });
  };

  return (
    <div
      ref={rowRef}
      className="sticky top-[var(--aura-shell-bar-height)] z-[5] -mx-[var(--page-padding-x)] bg-[var(--aura-bg-canvas)] px-[var(--page-padding-x)]"
      onClick={onClick}
    >
      <Tabs
        touchHeight
        label={label}
        value={current}
        current="location"
        tabs={links.map((l) => ({ id: l.id, label: l.label, href: `#${l.id}` }))}
      />
    </div>
  );
}
