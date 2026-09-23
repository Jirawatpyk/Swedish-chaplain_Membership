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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
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
  vi.mocked(toast.error).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tSchedule = enMessages.admin.broadcasts.approval.schedule;
const tErrors = enMessages.admin.broadcasts.approval.errors;
const refusal = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function chooseSendNow(): Promise<void> {
  fireEvent.click(document.querySelector('label[for="schedule-mode-send_now"]')!);
  await waitFor(() => expect(mode('send_now')).toHaveAttribute('aria-checked', 'true'));
}

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
    // H2 — unavailable, but still focusable (`aria-disabled`, never native `disabled`).
    expect(screen.getByTestId('schedule-confirm-submit')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('schedule-confirm-submit')).not.toHaveAttribute('disabled');
    // LOW — the unavailable keep option says why: it points at the proposal line.
    expect(mode('keep_proposal')).toHaveAttribute('aria-describedby', 'schedule-confirm-proposal');
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
    expect(screen.getByTestId('schedule-confirm-submit')).toHaveAttribute('aria-disabled', 'false');
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

  it('M4: the "differs" live region is mounted (empty) from the start, so the callout is ANNOUNCED when it appears', async () => {
    renderAction({
      status: 'member_approved',
      proposedSendAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    });
    open();
    const dialog = await screen.findByRole('alertdialog');
    const region = within(dialog).getByRole('status');
    expect(region).toHaveTextContent('');

    await chooseSendNow();
    await waitFor(() => expect(region).toHaveTextContent(/not the member.s proposed time/));
    expect(within(dialog).getByRole('status')).toBe(region);
  });

  it('LOW: with no proposal the keep option is not offered at all', async () => {
    renderAction({ status: 'member_approved', proposedSendAt: null });
    open();
    await screen.findByRole('alertdialog');
    expect(mode('keep_proposal')).toBeNull();
    expect(mode('schedule')).not.toBeNull();
  });

  it('LOW: a radio is named by its <label> alone (no competing aria-label)', async () => {
    renderAction({ status: 'approved', proposedSendAt: null });
    open();
    await screen.findByRole('alertdialog');
    expect(mode('send_now')).not.toHaveAttribute('aria-label');
  });

  it.each([
    [429, 'broadcast_rate_limit_exceeded', tErrors.broadcast_rate_limit_exceeded],
    [422, 'image_source_not_allowlisted', tErrors.image_source_not_allowlisted],
    [500, 'internal_error', tErrors.internal_error],
  ] as const)(
    'H1: a %s refusal is said INSIDE the dialog (role=alert), not by a toast the modal hides',
    async (status, code, text) => {
      vi.stubGlobal('fetch', vi.fn(async () => refusal(status, code)));
      renderAction({ status: 'approved', proposedSendAt: null });
      open();
      const dialog = await screen.findByRole('alertdialog');
      await chooseSendNow();
      fireEvent.click(screen.getByTestId('schedule-confirm-submit'));

      const alert = await within(dialog).findByRole('alert');
      expect(alert).toHaveTextContent(text);
      expect(toast.error).not.toHaveBeenCalled();
      expect(screen.getByRole('alertdialog')).toBe(dialog);
    },
  );

  it('H1: a repeated refusal is a NEW alert node (cleared at the start of each request), so it is announced again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refusal(429, 'broadcast_rate_limit_exceeded')));
    renderAction({ status: 'approved', proposedSendAt: null });
    open();
    const dialog = await screen.findByRole('alertdialog');
    await chooseSendNow();

    fireEvent.click(screen.getByTestId('schedule-confirm-submit'));
    const first = await within(dialog).findByRole('alert');
    // The alert lands before the transition settles; a click while still
    // `pending` is (correctly) refused, so wait for the button to come back.
    await waitFor(() => expect(screen.getByTestId('schedule-confirm-submit')).toHaveAttribute('aria-disabled', 'false'));
    fireEvent.click(screen.getByTestId('schedule-confirm-submit'));
    await waitFor(() => expect(within(dialog).getByRole('alert')).not.toBe(first));
  });

  it('H1: a network failure is said inside the dialog too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    renderAction({ status: 'approved', proposedSendAt: null });
    open();
    const dialog = await screen.findByRole('alertdialog');
    await chooseSendNow();
    fireEvent.click(screen.getByTestId('schedule-confirm-submit'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(tErrors.generic);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('M4: a 422 too_soon from the route moves focus to the time picker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refusal(422, 'broadcast_schedule_too_soon')));
    renderAction({
      status: 'member_approved',
      proposedSendAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    });
    open();
    await screen.findByRole('alertdialog');
    const submit = screen.getByTestId('schedule-confirm-submit');
    submit.focus();
    fireEvent.click(submit);

    const when = await screen.findByTestId('schedule-confirm-when');
    await waitFor(() => expect(document.activeElement).toBe(when));
    expect(when).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(tSchedule.tooSoon)).toBeInTheDocument();
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
