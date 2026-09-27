'use client';

/**
 * WCAG 2.2 SC 2.4.11 (Focus Not Obscured) — shared by the fixed-bottom bulk
 * bars (members, renewals pipeline, E-Blast review queue).
 *
 * Each bar renders a spacer of its measured height, which only makes the page
 * long enough to scroll the last row clear. The browser still aligns focus and
 * scroll-into-view to the VIEWPORT edge, i.e. under the bar. Setting
 * `scroll-padding-bottom` on the root scroller moves that edge up by the bar's
 * height. (`scroll-margin` on the bar itself does nothing — it only applies to
 * the element being scrolled TO.)
 *
 * The previous inline value is restored when the bar hides or unmounts, so no
 * other page inherits the offset. Assumes ONE bar per page (true for all three
 * callers): two overlapping bars would each restore the value they found.
 */

import { useEffect } from 'react';

export function useFixedBarScrollPadding(active: boolean, barHeight: number): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const previous = root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom = `${barHeight}px`;
    return () => {
      root.style.scrollPaddingBottom = previous;
    };
  }, [active, barHeight]);
}
