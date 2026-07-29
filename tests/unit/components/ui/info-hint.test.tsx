/**
 * `InfoHint` — the shared ⓘ popover system pattern (UX-review follow-up F1).
 *
 * Pins the interaction contract that distinguishes it from the Tooltip it
 * replaced (the T160 regression class): a NATIVE `<button>` trigger that is
 * keyboard-focusable and opens on click/tap AND Enter/Space, closes on ESC
 * and outside click, with Base UI wiring `aria-expanded` on the trigger.
 *
 * `vi.useRealTimers()` — the shared harness installs fake timers that hang
 * `waitFor`/userEvent (memory: component test harness fake timers).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InfoHint } from '@/components/ui/info-hint';

beforeEach(() => vi.useRealTimers());

const BODY = 'Counts by due date, not issue date.';

function renderHint() {
  return render(<InfoHint ariaLabel="About this figure">{BODY}</InfoHint>);
}

describe('InfoHint', () => {
  it('renders a focusable native button with the given accessible name, closed by default', () => {
    renderHint();
    const trigger = screen.getByRole('button', { name: 'About this figure' });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(BODY)).toBeNull();
    trigger.focus();
    expect(trigger).toHaveFocus();
  });

  it('opens on click and closes on ESC', async () => {
    const user = userEvent.setup();
    renderHint();
    const trigger = screen.getByRole('button', { name: 'About this figure' });

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText(BODY)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText(BODY)).toBeNull());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens with the keyboard (Enter on the focused trigger)', async () => {
    const user = userEvent.setup();
    renderHint();
    const trigger = screen.getByRole('button', { name: 'About this figure' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(BODY)).toBeInTheDocument();
  });

  it('closes on outside click (tap-away on touch)', async () => {
    const user = userEvent.setup();
    renderHint();
    await user.click(screen.getByRole('button', { name: 'About this figure' }));
    expect(await screen.findByText(BODY)).toBeInTheDocument();

    await user.click(document.body);
    await waitFor(() => expect(screen.queryByText(BODY)).toBeNull());
  });
});
