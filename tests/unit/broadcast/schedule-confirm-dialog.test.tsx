// @vitest-environment jsdom
/**
 * F119 T064 (US1-AS5, FR-017, FR-018) — marketing confirms the send time.
 *
 * The member's proposal is shown and PRE-SELECTED only while it is still at
 * least 5 minutes away (the route's floor, `broadcast_schedule_too_soon`); a
 * proposal that has passed must not be the default, and the picker becomes
 * required. The dialog offers exactly the modes the route accepts from the
 * current stage (`keep_proposal` from `approved` and `cancel` from
 * `member_approved` answer 409 `mode_not_allowed`), and focus returns to the
 * trigger on close.
 *
 * Focus test recipe (memory: a `user.click` open cannot tell `finalFocus` from
 * Base UI's default restore): focus a SIBLING first, open with
 * `fireEvent.click`, so the default would restore to the sibling and only
 * `finalFocus` names the trigger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ScheduleConfirmAction } from '@/components/broadcast/approval/schedule-confirm-dialog';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const HOUR_MS = 60 * 60 * 1000;
const ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  // The shared setup installs fake timers; Base UI's focus return and
  // `waitFor` both need real ones.
  vi.useRealTimers();
});
afterEach(cleanup);

function renderAction(props: {
  status: 'member_approved' | 'approved';
  proposedSendAt: string | null;
  scheduledFor?: string | null;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <button type="button" data-testid="elsewhere">
        elsewhere
      </button>
      <ScheduleConfirmAction
        broadcastId={ID}
        status={props.status}
        proposedSendAt={props.proposedSendAt}
        scheduledFor={props.scheduledFor ?? null}
      />
    </NextIntlClientProvider>,
  );
}

function open(): void {
  fireEvent.click(screen.getByTestId('schedule-confirm-trigger'));
}

function mode(value: string): HTMLElement | null {
  return screen.queryByTestId(`schedule-mode-${value}`);
}

describe('F119 T064 — the schedule confirmation dialog', () => {
  it('a past proposal is not pre-selected and the picker is required', async () => {
    renderAction({
      status: 'member_approved',
      proposedSendAt: new Date(Date.now() - HOUR_MS).toISOString(),
    });
    open();
    await screen.findByRole('alertdialog');

    expect(mode('keep_proposal')).toHaveAttribute('aria-checked', 'false');
    expect(mode('schedule')).toHaveAttribute('aria-checked', 'true');
    const when = screen.getByTestId('schedule-confirm-when');
    expect(when).toBeRequired();
    expect(when).toHaveValue('');
    expect(screen.getByTestId('schedule-confirm-submit')).toBeDisabled();
  });

  it('a proposal still far enough away IS pre-selected (positive control)', async () => {
    renderAction({
      status: 'member_approved',
      proposedSendAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    });
    open();
    await screen.findByRole('alertdialog');

    expect(mode('keep_proposal')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('schedule-confirm-when')).toBeNull();
    expect(screen.getByTestId('schedule-confirm-submit')).toBeEnabled();
    // Nothing differs while the member's own time is kept.
    expect(screen.queryByTestId('schedule-confirm-differs')).toBeNull();
  });

  it('choosing another time than the proposal calls out the difference', async () => {
    renderAction({
      status: 'member_approved',
      proposedSendAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    });
    open();
    await screen.findByRole('alertdialog');

    // A Base UI radio selects on its LABEL in jsdom, not on the role=radio node.
    fireEvent.click(document.querySelector('label[for="schedule-mode-send_now"]')!);
    await waitFor(() => expect(mode('send_now')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByTestId('schedule-confirm-differs')).toBeInTheDocument();
  });

  it.each([
    ['member_approved', ['keep_proposal', 'schedule', 'send_now'], ['cancel']],
    ['approved', ['schedule', 'send_now', 'cancel'], ['keep_proposal']],
  ] as const)('from %s it offers only the modes the route accepts', async (status, offered, refused) => {
    renderAction({ status, proposedSendAt: new Date(Date.now() + 2 * HOUR_MS).toISOString() });
    open();
    await screen.findByRole('alertdialog');

    for (const m of offered) expect(mode(m)).not.toBeNull();
    for (const m of refused) expect(mode(m)).toBeNull();
  });

  it('focus returns to the trigger on close', async () => {
    renderAction({
      status: 'member_approved',
      proposedSendAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    });
    const trigger = screen.getByTestId('schedule-confirm-trigger');
    screen.getByTestId('elsewhere').focus();
    open();
    await screen.findByRole('alertdialog');

    fireEvent.click(screen.getByTestId('schedule-confirm-cancel'));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
