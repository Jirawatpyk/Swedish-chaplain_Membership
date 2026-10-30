'use client';

/**
 * WCAG 2.2 SC 2.4.11 (Focus Not Obscured) — the room a focused field needs
 * above a viewport ActionBar: the bar's measured height, plus its offset from
 * the screen's bottom edge (it rides above the bottom nav), plus a gap. Feed
 * it to `useFixedBarScrollPadding`.
 *
 * Only while the bar is AURA's sticky floating card (640px and up): below
 * that it is AURA's fixed edge strip, which pads the page itself (D-039).
 *
 * Measured rather than a fixed stylesheet allowance, because the card's
 * height moves with its content: a long status or start slot wraps it onto a
 * second row (the E-Blast detail bar in Swedish at 640–767px, 200% text). A ResizeObserver keeps
 * the number current. Returns 0 while inactive or when no bar matches, so the
 * stylesheet's own allowance stays in charge until a measure exists.
 */
import { useEffect, useState, type RefObject } from 'react';
import { useFixedBarScrollPadding } from './use-fixed-bar-scroll-padding';

/** Room between the bar's top and a focused field. */
const FOCUS_GAP_PX = 16;

/**
 * `target` is the bar: a ref to it when the caller holds one (exactly that bar,
 * whatever else is on the page), or a selector when the bar lives in another
 * component.
 */
export function useActionBarClearance(active: boolean, target: string | RefObject<HTMLElement | null>): number {
  const [clearance, setClearance] = useState(0);
  useEffect(() => {
    if (!active) return;
    const bar = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target.current;
    if (!bar) return;
    const measure = () => {
      const style = getComputedStyle(bar);
      // Only the sticky floating card (from 640px) is ours to clear. Below
      // 640px the bar is AURA's edge strip (`edgeBelow="sm"`, D-039),
      // `position: fixed`, and AURA pads the page and sets the scroll padding
      // itself from `--aura-actionbar-height`; counting it here would double
      // it. On a short screen (`max-height: 30rem`: 400% zoom, a phone held
      // sideways) AURA un-sticks the bar into the flow, where it covers nothing.
      if (style.position !== 'sticky') {
        setClearance(0);
        return;
      }
      const offset = parseFloat(style.bottom);
      setClearance(Math.ceil(bar.getBoundingClientRect().height + (Number.isFinite(offset) ? offset : 0) + FOCUS_GAP_PX));
    };
    measure();
    // A size change re-measures; so do the short-screen switch, which moves
    // the bar in or out of the flow without resizing it, and the 640px switch
    // between AURA's sticky card and its fixed edge strip (D-039), so an
    // inline value never outlives the card. A `bottom` change alone (the
    // bottom nav hiding) is not seen: no page that uses this hides its nav.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(bar);
    const queries =
      typeof window.matchMedia === 'function'
        ? [window.matchMedia('(max-height: 30rem)'), window.matchMedia('(min-width: 40rem)')]
        : [];
    for (const q of queries) q.addEventListener('change', measure);
    return () => {
      observer?.disconnect();
      for (const q of queries) q.removeEventListener('change', measure);
      // Never keep a number from the last time it was on.
      setClearance(0);
    };
  }, [active, target]);
  return active ? clearance : 0;
}

/**
 * The pair every viewport bar needs: measure the bar, and keep that much clear
 * at the bottom of the root scroller while it shows. Until the first measure
 * (or while the bar is un-stuck) nothing is set inline, so the stylesheet's
 * allowance stays in charge.
 */
export function useActionBarScrollPadding(active: boolean, target: string | RefObject<HTMLElement | null>): void {
  const clearance = useActionBarClearance(active, target);
  useFixedBarScrollPadding(active && clearance > 0, clearance);
}
