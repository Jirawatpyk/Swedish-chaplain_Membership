/**
 * `CombinedReceiptHint` — T160 regression fix (UX-review follow-up F1).
 *
 * The pre-fix implementation overrode the Tooltip trigger with
 * `render={<span/>}`, losing native focusability — keyboard users could
 * never reach the hint and touch users had no hover to trigger it. Ported
 * to the shared `InfoHint` popover; these tests pin exactly the properties
 * the regression lost. Props are plain strings passed by the portal page
 * from its own i18n keys, so no NextIntlClientProvider is needed here.
 *
 * `vi.useRealTimers()` — the shared harness installs fake timers that hang
 * `waitFor`/userEvent (memory: component test harness fake timers).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CombinedReceiptHint } from '@/app/(member)/portal/invoices/_components/combined-receipt-hint';

beforeEach(() => vi.useRealTimers());

const ARIA = 'Receipt number: combined with invoice number';
const TIP = 'This tenant issues combined invoice/receipt documents.';

function renderHint() {
  return render(<CombinedReceiptHint ariaLabel={ARIA} tooltipText={TIP} />);
}

describe('CombinedReceiptHint', () => {
  it('renders the em-dash placeholder plus a FOCUSABLE native-button hint trigger (the T160 fix)', () => {
    renderHint();
    expect(screen.getByText('—')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: ARIA });
    expect(trigger.tagName).toBe('BUTTON');
    trigger.focus();
    expect(trigger).toHaveFocus();
  });

  it('opens the explanation popover on click and closes on ESC', async () => {
    const user = userEvent.setup();
    renderHint();
    const trigger = screen.getByRole('button', { name: ARIA });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(await screen.findByText(TIP)).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText(TIP)).toBeNull());
  });

  it('opens with the keyboard (Enter on the focused trigger)', async () => {
    const user = userEvent.setup();
    renderHint();
    const trigger = screen.getByRole('button', { name: ARIA });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(TIP)).toBeInTheDocument();
  });
});
