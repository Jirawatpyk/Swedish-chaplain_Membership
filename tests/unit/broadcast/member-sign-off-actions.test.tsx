// @vitest-environment jsdom
/**
 * F119 T067 · T084 (US2-AS1, FR-009, FR-010, FR-015a) — the member's sign-off
 * controls on `/portal/broadcasts/[id]`.
 *
 *   - Request changes needs a reason (1–2,000). An empty reason is refused
 *     with an ANNOUNCED field error: the field is `aria-invalid`, described by
 *     the error, and the error is a `role="alert"` (ux-standards § 4.1) —
 *     whether the client catches it on blur or the server answers 422
 *     `reason_required`.
 *   - Every dialog returns focus to its trigger when it closes.
 *   - Approve is confirmed in a dialog that states marketing now confirms the
 *     send time and that the content cannot change without a new approval.
 *   - A refusal that keeps a dialog open is said INSIDE it — a toast renders
 *     outside the modal, which hides everything outside itself from AT.
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
import { MemberSignOffActions } from '@/components/broadcast/approval/member-sign-off-actions';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ID = '11111111-1111-4111-8111-111111111111';
const VERSION = { id: '22222222-2222-4222-8222-222222222222', versionNo: 2 };
const t = enMessages.portal.broadcasts.approval;

beforeEach(() => {
  // The shared setup installs fake timers; Base UI's focus return and
  // `waitFor` both need real ones.
  vi.useRealTimers();
  refresh.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderActions(over: Partial<{ canDecide: boolean; canWithdrawApproval: boolean; canWithdrawEblast: boolean }> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <button type="button" data-testid="elsewhere">
        elsewhere
      </button>
      <MemberSignOffActions
        broadcastId={ID}
        subject="Autumn mixer"
        version={VERSION}
        canDecide={over.canDecide ?? true}
        canWithdrawApproval={over.canWithdrawApproval ?? false}
        canWithdrawEblast={over.canWithdrawEblast ?? false}
      />
    </NextIntlClientProvider>,
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function openRequestChanges(): Promise<{ dialog: HTMLElement; reason: HTMLTextAreaElement }> {
  fireEvent.click(screen.getByTestId('eblast-request-changes'));
  const dialog = await screen.findByRole('alertdialog');
  const reason = within(dialog).getByLabelText(t.requestChanges.reasonLabel) as HTMLTextAreaElement;
  return { dialog, reason };
}

function expectAnnouncedFieldError(reason: HTMLTextAreaElement, message: string): void {
  expect(reason).toHaveAttribute('aria-invalid', 'true');
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent(message);
  expect(reason.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
}

describe('F119 T067 — Request changes without a reason', () => {
  it('the reason field is aria-invalid and its error is announced', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderActions();
    const { reason } = await openRequestChanges();

    // Left blank: refused on the field, before anything is posted.
    fireEvent.blur(reason);
    await waitFor(() => expectAnnouncedFieldError(reason, t.requestChanges.errors.reasonRequired));
    expect(fetchMock).not.toHaveBeenCalled();

    // Typing clears it — the error follows the field, not the dialog.
    fireEvent.change(reason, { target: { value: 'The date is wrong.' } });
    await waitFor(() => expect(reason).not.toHaveAttribute('aria-invalid', 'true'));
  });

  it('a 422 reason_required from the server marks the same field, inside the open dialog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(422, { error: { code: 'reason_required', fieldErrors: { reason: ['reason_required'] } } })),
    );
    renderActions();
    const { dialog, reason } = await openRequestChanges();
    fireEvent.change(reason, { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t.requestChanges.confirm }));

    await waitFor(() => expectAnnouncedFieldError(reason, t.errors.reason_required));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('F119 T084 — the member sign-off controls', () => {
  it.each([
    ['eblast-approve', { canDecide: true }, t.approveDialog.cancel],
    ['eblast-request-changes', { canDecide: true }, t.requestChanges.cancel],
    ['eblast-withdraw-approval', { canDecide: false, canWithdrawApproval: true }, t.withdrawApproval.cancel],
  ] as const)('each dialog returns focus to its trigger (%s)', async (testId, flags, cancelLabel) => {
    renderActions(flags);
    const trigger = screen.getByTestId(testId);
    screen.getByTestId('elsewhere').focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('alertdialog');

    fireEvent.click(within(dialog).getByRole('button', { name: cancelLabel }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('Approve states both consequences, then posts the version with the optional note', async () => {
    const fetchMock = vi.fn(async () =>
      json(200, { stage: 'member_approved', whoseTurn: 'marketing', round: 2, decision: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderActions();
    fireEvent.click(screen.getByTestId('eblast-approve'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(t.approveDialog.description);

    fireEvent.change(within(dialog).getByLabelText(t.approveDialog.noteLabel), { target: { value: '  Looks great  ' } });
    fireEvent.click(within(dialog).getByTestId('eblast-approve-confirm'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/broadcasts/${ID}/decision`);
    expect(JSON.parse(init.body as string)).toEqual({ versionId: VERSION.id, decision: 'approved', reason: 'Looks great' });
    // The page re-renders into the new stage; its banner announces it.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('a 429 while withdrawing an approval is said inside the open dialog, not by a toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { error: { code: 'broadcast_rate_limit_exceeded' } })));
    renderActions({ canDecide: false, canWithdrawApproval: true });
    fireEvent.click(screen.getByTestId('eblast-withdraw-approval'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText(t.withdrawApproval.reasonLabel), {
      target: { value: 'We found a typo in the date.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t.withdrawApproval.confirm }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(t.errors.broadcast_rate_limit_exceeded);
    expect(toast.error).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a 409 stage_changed closes the dialog and refreshes the page (the view is stale)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { error: { code: 'stage_changed' } })));
    renderActions();
    fireEvent.click(screen.getByTestId('eblast-approve'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByTestId('eblast-approve-confirm'));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(refresh).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(t.errors.stage_changed);
  });
});
