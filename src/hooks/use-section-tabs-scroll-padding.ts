'use client';

/**
 * A sticky section-tab row under the shell bar (the member detail page's
 * "On this page" tabs) publishes its measured height as `--chamber-section-tabs-height`
 * on the root. `globals.css` adds it to `scroll-padding-top`, so a section
 * reached by its anchor lands below the shell bar AND the row, whatever
 * height the row has at this width, locale or zoom — no fixed number.
 *
 * A row that is not sticky at this width (the invoice settings tabs on a
 * phone) publishes 0, since it scrolls away with the page; crossing the
 * breakpoint changes its `position`, not its size, so window resizes count too.
 *
 * The variable is removed on unmount, so a page without tabs keeps the plain
 * shell-bar offset. Assumes one tab row per page.
 */

import { useEffect, type RefObject } from 'react';

const VAR = '--chamber-section-tabs-height';

export function useSectionTabsScrollPadding(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      const sticky = getComputedStyle(el).position === 'sticky';
      root.style.setProperty(VAR, `${sticky ? Math.ceil(el.getBoundingClientRect().height) : 0}px`);
    };
    publish();
    // The row's own size where ResizeObserver exists (not in jsdom).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(el);
    window.addEventListener('resize', publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty(VAR);
    };
  }, [ref]);
}
