'use client';

/**
 * WCAG 2.2 SC 2.4.11 (Focus Not Obscured) — the viewport bars (the staff bulk
 * bars, E-Blast compose, the invoice save bar), through
 * `useActionBarScrollPadding`.
 *
 * The browser aligns focus and scroll-into-view to the VIEWPORT edge, i.e.
 * under a sticky bottom bar. Setting `scroll-padding-bottom` on the root
 * scroller moves that edge up by `clearance`: the bar's height, its offset
 * above the screen edge and a gap (`useActionBarClearance`). (`scroll-margin`
 * on the bar itself does nothing — it only applies to the element being
 * scrolled TO.)
 *
 * The previous inline value is restored when the bar hides or unmounts, so no
 * other page inherits the offset. Assumes ONE bar per page (true for every
 * caller): two overlapping bars would each restore the value they found.
 */

import { useEffect } from 'react';

export function useFixedBarScrollPadding(active: boolean, clearance: number): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const previous = root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom = `${clearance}px`;
    return () => {
      root.style.scrollPaddingBottom = previous;
    };
  }, [active, clearance]);
}
