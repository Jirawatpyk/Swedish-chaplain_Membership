/**
 * Task 3 (2026-08-02-broadcast-review-queue-pr3) — `BulkApproveConfirmDialog`
 * unit tests.
 *
 * This is the send-safety gate in front of the irreversible bulk-approve
 * fan-out (Task 4 wires it into `queue-bulk-action-bar.tsx`'s "Approve
 * selected" button). Load-bearing assertions:
 *
 *   - the recipient total + broadcast count render in the description
 *     (DISPLAY-ONLY — this component never fetches; it only calls
 *     `onConfirm(decision)`, and `decision` structurally cannot carry a
 *     recipients field. Task 4's tamper-safety test proves the request
 *     body built from `decision` never includes it.)
 *   - the over-cap note renders only when `selectedCount > cap`
 *   - send-now is irreversible-warned and confirms with exactly
 *     `{type:'send_now'}`
 *   - the confirm button stays disabled until a valid (>5min) Bangkok-TZ
 *     schedule is entered — this fixes a gap `approve-dialog.tsx` has
 *     today, where the button is only guarded on `scheduledFor === ''`
 *     (not lead-time), so a too-soon schedule is clickable and only
 *     rejected inside the click handler.
 *   - `scheduledFor` is the UTC ISO instant from the SHARED
 *     `bangkok-datetime.ts` helper, not `new Date(localString)` (which
 *     would use the test runner's own TZ): a `09:00` Bangkok (UTC+7)
 *     input must yield `02:00:00.000Z`.
 *   - a resolved Bangkok-wall-time preview renders once the schedule is
 *     parseable (Fix round 1 — parity with `approve-dialog.tsx`'s preview),
 *     showing a FORMATTED date, not the raw `datetime-local` string echoed
 *     back.
 *   - (Fix round 1, MOST IMPORTANT) `handleConfirm`'s fresh `Date.now()`
 *     re-check is exercised directly via `vi.spyOn(Date, 'now')`: a button
 *     left visually-enabled (`leadTimeOk` computed when the lead time was
 *     still OK) must NOT let `onConfirm` fire once the clock advances past
 *     the 5-minute floor without the input being re-touched. This guards
 *     against a future "simplification" that trusts the cached boolean and
 *     silently reopens the too-soon-schedule gap this dialog exists to close.
 *
 * Base UI Radio dispatches via PointerEvent, which jsdom does not
 * implement — polyfill copied from
 * tests/unit/components/schedules/schedule-editor.test.tsx /
 * tests/unit/broadcast/queue-with-bulk.test.tsx.
 *
 * `vi.useRealTimers()` — shared test setup (tests/setup.ts) installs fake
 * timers globally, under which `@testing-library/user-event` never
 * resolves (dies on the 30s test timeout). Precedent:
 * queue-with-bulk.test.tsx, queue-bulk-action-bar.test.tsx.
 *
 * `next/navigation` is mocked per the brief's harness instructions, even
 * though this presentational dialog does not call `useRouter()` itself
 * (unlike `ApproveDialog`) — kept for harness parity with the sibling
 * dialog tests in this directory.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  BulkApproveConfirmDialog,
  type BulkApproveConfirmDialogProps,
} from '@/components/broadcast/admin/bulk-approve-confirm-dialog';
import { bangkokInputToIso } from '@/components/broadcast/bangkok-datetime';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  // Restores any `vi.spyOn(Date, 'now')` from the stale-guard test below so
  // a failure there can't poison the clock for later tests in this file.
  vi.restoreAllMocks();
});

function renderDialog(
  overrides: Partial<BulkApproveConfirmDialogProps> = {},
): BulkApproveConfirmDialogProps {
  const props: BulkApproveConfirmDialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    broadcastCount: 3,
    selectedCount: 3,
    cap: 100,
    totalRecipients: 42,
    onConfirm: vi.fn(),
    ...overrides,
  };
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BulkApproveConfirmDialog {...props} />
    </NextIntlClientProvider>,
  );
  return props;
}

describe('BulkApproveConfirmDialog', () => {
  it('shows the recipient total and broadcast count', () => {
    renderDialog({ broadcastCount: 3, selectedCount: 3, totalRecipients: 42 });
    expect(
      screen.getByText(/Reaches ~42 recipients across 3 broadcasts/),
    ).toBeInTheDocument();
  });

  it('warns the send is irreversible in send-now mode (default)', () => {
    renderDialog({});
    expect(
      screen.getByText(/send immediately and cannot be recalled/),
    ).toBeInTheDocument();
  });

  it('shows the over-cap note when selectedCount > cap', () => {
    renderDialog({ broadcastCount: 100, selectedCount: 120, cap: 100 });
    expect(
      screen.getByText(/Only the first 100 of 120 selected will be approved/),
    ).toBeInTheDocument();
  });

  it('confirms send-now with {type:"send_now"}', async () => {
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });
    await userEvent.click(
      screen.getByRole('button', { name: /Approve & send now/ }),
    );
    expect(onConfirm).toHaveBeenCalledWith({ type: 'send_now' });
  });

  it('disables confirm until a valid (>5min) schedule time is entered', async () => {
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });
    await userEvent.click(screen.getByRole('radio', { name: /Schedule/ }));
    const confirm = screen.getByRole('button', { name: /Approve & schedule/ });
    expect(confirm).toBeDisabled(); // empty schedule
    // a far-future Bangkok wall-time enables it and confirms with an ISO scheduledFor
    const input = screen.getByLabelText(/Send at/);
    fireEvent.change(input, { target: { value: '2099-01-01T09:00' } });
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({
      type: 'schedule',
      scheduledFor: expect.stringMatching(/^2099-01-01T02:00:00\.000Z$/),
    });
  });

  it('shows a formatted Bangkok-time preview once a valid schedule is entered', async () => {
    renderDialog({});
    await userEvent.click(screen.getByRole('radio', { name: /Schedule/ }));
    const input = screen.getByLabelText(/Send at/);
    fireEvent.change(input, { target: { value: '2099-01-01T09:00' } });

    expect(screen.getByText(/Will be sent on:/)).toBeInTheDocument();

    // The preview must show a FORMATTED date resolved from the shared TZ
    // helper — not the raw datetime-local string echoed back verbatim.
    const expectedPreview = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Bangkok',
    }).format(new Date('2099-01-01T02:00:00.000Z'));
    expect(screen.getByText(expectedPreview)).toBeInTheDocument();
    expect(screen.queryByText('2099-01-01T09:00')).not.toBeInTheDocument();
  });

  it('re-validates lead time at click time — a stale-enabled button cannot submit a too-soon schedule', async () => {
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });
    // Base UI Radio dispatches via PointerEvent internally — `userEvent.click`
    // (not `fireEvent.click`) is required to actually flip the selection, per
    // the polyfill note above.
    await userEvent.click(screen.getByRole('radio', { name: /Schedule/ }));

    const targetLocal = '2099-01-01T09:00';
    const targetIso = bangkokInputToIso(targetLocal);
    expect(targetIso).not.toBeNull();
    const xMs = Date.parse(targetIso!);

    const nowSpy = vi.spyOn(Date, 'now');

    // 6 minutes before the target — clears the 5-minute floor, so typing it
    // now enables the button.
    nowSpy.mockReturnValue(xMs - 6 * 60 * 1000);
    const input = screen.getByLabelText(/Send at/);
    fireEvent.change(input, { target: { value: targetLocal } });
    const confirm = screen.getByRole('button', { name: /Approve & schedule/ });
    expect(confirm).toBeEnabled();

    // The clock advances to only 4 minutes before the target — below the
    // 5-minute floor — WITHOUT re-touching the input, so the cached
    // `leadTimeOk` state (computed at the 6-minute mark) stays stale-true
    // and the button remains visually enabled.
    nowSpy.mockReturnValue(xMs - 4 * 60 * 1000);
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    // The fresh re-check inside `handleConfirm` must still block the submit.
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
