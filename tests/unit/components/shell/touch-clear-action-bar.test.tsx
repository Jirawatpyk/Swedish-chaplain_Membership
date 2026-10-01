/**
 * `<TouchClearActionBar>` — 122 stand-in for AURA handoff #122 (R24).
 *
 * AURA's ActionBar draws its own "Clear" for `onClearSelection` as a 32px
 * button with no way to give it the 44px touch height the bulk bars need
 * (WCAG 2.5.5, `renewal-a11y` "44px targets"). Until AURA ships it, this
 * wrapper renders the Clear itself, with `touchHeight`, first among the
 * actions as AURA places it, and keeps AURA's focus return: after a Clear
 * empties the selection (the bar goes idle and its buttons leave), focus goes
 * back to where it came from before it entered the bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Button } from '@jirawatpyk/aura-react';
import { TouchClearActionBar } from '@/components/shell/touch-clear-action-bar';

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => cleanup());

function Harness({ onClear = vi.fn() }: { onClear?: () => void }) {
  const [selected, setSelected] = useState(2);
  return (
    <>
      <button type="button">Row checkbox</button>
      <TouchClearActionBar
        label="Bulk actions"
        clearLabel="Clear selection"
        selected={selected}
        onClearSelection={() => {
          onClear();
          setSelected(0);
        }}
      >
        <Button size="sm" touchHeight>
          Send
        </Button>
      </TouchClearActionBar>
    </>
  );
}

describe('<TouchClearActionBar>', () => {
  it('renders Clear first among the actions, as a 44px touch target', () => {
    render(<Harness />);
    const region = screen.getByRole('region', { name: 'Bulk actions' });
    const buttons = within(region).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Clear selection', 'Send']);
    expect(buttons[0]).toHaveClass('aura-btn--touch');
    expect(region).toHaveTextContent('2 selected');
  });

  it('Clear calls onClearSelection, and the idle bar drops its Clear', () => {
    const onClear = vi.fn();
    render(<Harness onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull();
  });

  it('returns focus to where it came from before entering the bar', async () => {
    render(<Harness />);
    const origin = screen.getByRole('button', { name: 'Row checkbox' });
    origin.focus();
    const clear = screen.getByRole('button', { name: 'Clear selection' });
    clear.focus();
    fireEvent.click(clear);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(origin).toHaveFocus();
  });
});
