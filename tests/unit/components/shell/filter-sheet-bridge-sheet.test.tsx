/**
 * AURA 5.91 #211 (review M-1) — with the real FilterBar, a list's own Clear
 * inside the phone Filters sheet leaves focus on the sheet's Done; in the row
 * it focuses the bar's search. Callers: plans, events list, attendees, timeline.
 */
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Button, FilterBar, Tag } from '@jirawatpyk/aura-react';
import { FilterSheetBridge, useFilterSheetRef } from '@/components/shell/filter-sheet-bridge';

function Harness({ phone }: { phone: boolean }) {
  const sheetRef = useFilterSheetRef();
  const [on, setOn] = useState(true);
  function clear() {
    const sheet = sheetRef.current;
    if (sheet?.inSheet) sheet.focusDone();
    setOn(false);
    if (!sheet?.inSheet) queueMicrotask(() => document.querySelector<HTMLElement>('input[type="search"]')?.focus());
  }
  return (
    <FilterBar collapseBelow={phone ? 'sm' : undefined} label="Filters" search="" searchLabel="Search" onSearchChange={() => {}}>
      <FilterSheetBridge ref={sheetRef} />
      <Tag selected={on} onClick={() => setOn(!on)}>Active</Tag>
      {on ? (
        <Button variant="ghost" size="sm" onClick={clear}>
          Clear filters
        </Button>
      ) : null}
    </FilterBar>
  );
}

const settle = async () => {
  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
  });
};
const realMatchMedia = window.matchMedia;

describe('FilterSheetBridge with the real FilterBar', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    // Below 640px: the bar collapses its controls into the Filters sheet.
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })) as unknown as typeof window.matchMedia;
  });
  afterAll(() => {
    window.matchMedia = realMatchMedia;
    vi.useRealTimers();
  });

  it("in the Filters sheet, the list's Clear leaves focus on Done", async () => {
    render(<Harness phone />);
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    await settle();
    const clear = screen.getByRole('button', { name: 'Clear filters' });
    clear.focus();
    fireEvent.click(clear);
    await settle();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
  });

  it("in the row, the list's Clear focuses the bar's search", async () => {
    render(<Harness phone={false} />);
    const clear = screen.getByRole('button', { name: 'Clear filters' });
    clear.focus();
    fireEvent.click(clear);
    await settle();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveFocus();
  });
});
