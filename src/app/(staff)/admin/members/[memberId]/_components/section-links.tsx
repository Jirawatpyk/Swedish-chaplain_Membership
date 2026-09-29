'use client';

/**
 * 122 US5b-1 (T553) — the member detail page's "On this page" links (board
 * `Admin-member-detail`; Clarifications, Session 2026-09-28: the board's tab
 * row becomes in-page links and every card stays on the page).
 *
 * AURA `Tabs` with an `href` on every tab renders a `nav` of links with the
 * current one marked; here "current" is the section in view, tracked with an
 * IntersectionObserver. Sticky under AURA's shell bar (its 56 px minimum
 * height; the bar has no height token), scrolling sideways on a phone. The
 * page lists only the sections this viewer has.
 */
import { useEffect, useState } from 'react';
import { Tabs } from '@jirawatpyk/aura-react';

export interface SectionLink {
  readonly id: string;
  readonly label: string;
}

export function SectionLinks({ label, links }: { readonly label: string; readonly links: readonly SectionLink[] }) {
  const [current, setCurrent] = useState(links[0]?.id);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        // The first section, in page order, that is in the band below the bar.
        const first = links.find((l) => visible.get(l.id));
        if (first) setCurrent(first.id);
      },
      // The band from under the sticky bar and links to the middle of the screen.
      { rootMargin: '-112px 0px -50% 0px' },
    );
    for (const l of links) {
      const el = document.getElementById(l.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [links]);

  return (
    <div className="sticky top-14 z-[5] -mx-[var(--page-padding-x)] bg-[var(--aura-bg-canvas)] px-[var(--page-padding-x)]">
      <Tabs
        label={label}
        value={current}
        tabs={links.map((l) => ({ id: l.id, label: l.label, href: `#${l.id}` }))}
      />
    </div>
  );
}
