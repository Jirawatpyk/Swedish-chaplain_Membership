'use client';

/**
 * WCAG 2.2 SC 2.4.11 (Focus Not Obscured) — the room a focused field needs
 * above a viewport ActionBar: the bar's measured height, plus its offset from
 * the screen's bottom edge (it rides above the bottom nav), plus a gap. Feed
 * it to `useFixedBarScrollPadding`.
 *
 * Measured rather than a fixed stylesheet allowance, because the bar's height
 * moves with its content: a phone bar wraps its start slot over the buttons
 * when the copy is long (the invoice save bar reaches about 103px at 390; the
 * E-Blast compose bar 62px on one row, 114px on two). A ResizeObserver keeps
 * the number current. Returns 0 while inactive or when no bar matches, so the
 * stylesheet's own allowance stays in charge until a measure exists.
 */
import { useEffect, useState, type RefObject } from 'react';

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
      // AURA un-sticks the bar on a short screen (`max-height: 30rem`: 400%
      // zoom, a phone held sideways), where it sits in the flow and covers
      // nothing; padding the root there would only crowd the focused field.
      if (style.position !== 'sticky' && style.position !== 'fixed') {
        setClearance(0);
        return;
      }
      const offset = parseFloat(style.bottom);
      setClearance(Math.ceil(bar.getBoundingClientRect().height + (Number.isFinite(offset) ? offset : 0) + FOCUS_GAP_PX));
    };
    measure();
    // A size change re-measures; so does the short-screen switch, which moves
    // the bar in or out of the flow without resizing it. A `bottom` change
    // alone (the bottom nav hiding) is not seen: no page that uses this hides
    // its nav.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(bar);
    const short = typeof window.matchMedia === 'function' ? window.matchMedia('(max-height: 30rem)') : null;
    short?.addEventListener('change', measure);
    return () => {
      observer?.disconnect();
      short?.removeEventListener('change', measure);
      // Never keep a number from the last time it was on.
      setClearance(0);
    };
  }, [active, target]);
  return active ? clearance : 0;
}
