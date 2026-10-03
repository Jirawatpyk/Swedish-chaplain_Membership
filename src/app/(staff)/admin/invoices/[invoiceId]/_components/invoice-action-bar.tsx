'use client';

/**
 * Spec 122 US8b (T824) — the invoice page's header actions, which below 640px
 * become a bar at the bottom of the screen (board `Admin-invoice-issued-mobile`):
 * the total (incl. VAT) and due date on top, then the actions, the main one
 * growing to fill the row beside the ⋯ menu.
 *
 * The actions are drawn once and only moved, so every dialog keeps one
 * trigger and its test id (spec Session 2026-10-02 US8b). Fixed, not sticky:
 * the actions live in the page header, and a sticky element only sticks
 * inside its parent. While the bar shows, the page's last content scrolls
 * clear of it (the view's spacer reads `--invoice-action-bar-height`) and
 * focus never lands under it (`scroll-padding-bottom`, WCAG 2.4.11).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useBelowSm } from '@/hooks/use-below-sm';
import { useFixedBarScrollPadding } from '@/hooks/use-fixed-bar-scroll-padding';

export const INVOICE_ACTION_BAR_HEIGHT_VAR = '--invoice-action-bar-height';

export function InvoiceActionBar({ summary, children }: { readonly summary: string | null; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const isPhone = useBelowSm();
  const [measured, setMeasured] = useState(0);
  // Only the fixed bar takes room; from 640px the actions sit in the header.
  const height = isPhone ? measured : 0;

  useEffect(() => {
    const el = ref.current;
    if (!isPhone || !el || typeof ResizeObserver === 'undefined') return;
    // A ResizeObserver reports once on observe, then on every size change.
    const ro = new ResizeObserver(() => setMeasured(Math.ceil(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isPhone]);

  useFixedBarScrollPadding(isPhone && height > 0, height);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(INVOICE_ACTION_BAR_HEIGHT_VAR, `${height}px`);
    return () => {
      root.style.removeProperty(INVOICE_ACTION_BAR_HEIGHT_VAR);
    };
  }, [height]);

  return (
    <div
      ref={ref}
      data-slot="invoice-action-bar"
      className="flex flex-col gap-2 max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-[var(--aura-z-bar)] max-sm:border-t max-sm:border-[var(--aura-border-default)] max-sm:bg-[var(--aura-bg-surface)] max-sm:px-[var(--aura-space-4)] max-sm:pt-[var(--aura-space-3)] max-sm:pb-[max(var(--aura-space-3),env(safe-area-inset-bottom,0px))]"
    >
      {summary ? <p className="text-xs tabular-nums text-[var(--aura-fg-secondary)] sm:hidden">{summary}</p> : null}
      {/* The actions share the row; the ⋯ menu keeps its own width. */}
      <div className="flex flex-wrap items-center gap-2 max-sm:[&>*]:flex-1 max-sm:[&>[data-slot=invoice-more-menu]]:flex-none">{children}</div>
    </div>
  );
}
