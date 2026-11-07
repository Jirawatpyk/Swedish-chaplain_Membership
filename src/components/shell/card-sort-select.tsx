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
 * The caller wraps this menu and its table in `CARD_SORT_CONTAINER`: the
 * table stacks below a 640px TABLE and `bleed` makes the table the card's two
 * paddings (2 × 24px from 640px up) wider than that wrapper, so the menu hides
 * from a 592px wrapper — the width at which the grid, with its sortable
 * headers, comes back.
 */
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
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly CardSortOption[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <div data-card-sort="" className="mb-[var(--aura-space-3)] @min-[592px]/cardsort:hidden">
      <Select
        touchHeight
        label={label}
        value={value}
        options={options as CardSortOption[]}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      />
    </div>
  );
}
