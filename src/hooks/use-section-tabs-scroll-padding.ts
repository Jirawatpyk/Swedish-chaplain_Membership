'use client';

/**
 * A sticky section-tab row under the shell bar (member detail, invoice
 * settings) publishes its measured height as `--chamber-section-tabs-height`
 * on the root. `globals.css` adds it to `scroll-padding-top`, so a section
 * reached by its anchor lands below the shell bar AND the row, whatever
 * height the row has at this width, locale or zoom — no fixed number.
 *
 * The variable is removed on unmount, so a page without tabs keeps the plain
 * shell-bar offset. Assumes one tab row per page (true for both callers).
 */

import { useEffect, type RefObject } from 'react';

const VAR = '--chamber-section-tabs-height';

export function useSectionTabsScrollPadding(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty(VAR, `${Math.ceil(el.getBoundingClientRect().height)}px`);
    publish();
    // Measured once where ResizeObserver is missing (jsdom), else on resize.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(VAR);
    };
  }, [ref]);
}
