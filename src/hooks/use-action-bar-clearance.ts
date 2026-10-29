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
import { useEffect, useState } from 'react';

/** Room between the bar's top and a focused field. */
const FOCUS_GAP_PX = 16;

export function useActionBarClearance(active: boolean, selector: string): number {
  const [clearance, setClearance] = useState(0);
  useEffect(() => {
    if (!active) return;
    const bar = document.querySelector<HTMLElement>(selector);
    if (!bar) return;
    const measure = () => {
      const offset = parseFloat(getComputedStyle(bar).bottom);
      setClearance(Math.ceil(bar.getBoundingClientRect().height + (Number.isFinite(offset) ? offset : 0) + FOCUS_GAP_PX));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(bar);
    return () => observer?.disconnect();
  }, [active, selector]);
  return active ? clearance : 0;
}
