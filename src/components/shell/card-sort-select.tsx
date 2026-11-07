'use client';

/**
 * A visible "Sort by" menu for a DataTable while it shows stacked cards.
 *
 * Since AURA 5.87 (#205) the grid's column headers, and with them the sort
 * buttons, leave the cards entirely; before, they were only visually hidden,
 * so a sighted phone user could never sort and a keyboard user tabbed onto
 * invisible 9px buttons. This menu is the phone's sort control: it shows only
 * while the cards show and writes the same URL as the grid's headers.
 *
 * The caller wraps this menu and its table in `CARD_SORT_CONTAINER`. The
 * table stacks below a 640px TABLE. Below the `sm` viewport the host card is
 * flush (no padding, no bleed), so the table is the wrapper's width and always
 * narrower than 640: the menu always shows. From `sm` up, `bleed` makes the
 * table the card's two paddings (2 × 24px) wider than the wrapper, so the menu
 * hides from a 592px wrapper — the width at which the grid, with its sortable
 * headers, comes back.
 *
 * After a pick the menu shows the chosen option at once (the URL catches up a
 * server round trip later) and, once the new order has arrived, a polite live
 * region says so: the cards have no `aria-sort` header to tell a screen-reader
 * user that anything changed (WCAG 4.1.3). The round trip also drops focus to
 * <body> in the browser (R144b), so focus goes back to the menu then, unless
 * the user has moved on.
 */
import { useEffect, useRef, useState } from 'react';
import { Select } from '@jirawatpyk/aura-react';

/** The query container the menu reads; put it on the wrapper of the menu and its table. */
export const CARD_SORT_CONTAINER = '@container/cardsort';

export interface CardSortOption {
  readonly value: string;
  readonly label: string;
}

export function CardSortSelect({
  label,
  value,
  options,
  onChange,
  announce,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly CardSortOption[];
  readonly onChange: (value: string) => void;
  /** The live-region text once the chosen order has arrived, e.g. "Sorted: {option}". */
  readonly announce: (optionLabel: string) => string;
}) {
  // The pick the URL has not caught up with yet.
  const [picked, setPicked] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  // React's "adjust state when a prop changes": once the URL-derived value
  // reaches the pick, the new order has arrived, so say so.
  const [seenValue, setSeenValue] = useState(value);
  // Bumped when the order arrives; the effect below then restores focus.
  const [arrivals, setArrivals] = useState(0);
  if (value !== seenValue) {
    setSeenValue(value);
    if (picked !== null && picked === value) {
      setPicked(null);
      const option = options.find((o) => o.value === value);
      setMessage(option ? announce(option.label) : '');
      setArrivals((n) => n + 1);
    }
  }

  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (arrivals === 0) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    wrapperRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus({ preventScroll: true });
  }, [arrivals]);

  return (
    <div ref={wrapperRef} data-card-sort="" className="mb-[var(--aura-space-3)] sm:@min-[592px]/cardsort:hidden">
      <Select
        touchHeight
        label={label}
        value={picked ?? value}
        options={options as CardSortOption[]}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
          const next = e.target.value;
          if (next === (picked ?? value)) return;
          setPicked(next);
          setMessage('');
          onChange(next);
        }}
      />
      <span data-card-sort-status="" role="status" aria-live="polite" className="sr-only">
        {message}
      </span>
    </div>
  );
}
