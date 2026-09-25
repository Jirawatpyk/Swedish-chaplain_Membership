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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

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
  vi.mocked(toast.warning).mockReset();
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
      json(200, { status: 'member_approved', whoseTurn: 'marketing', round: 2, decision: {} }),
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
    // The page re-renders into the new stage; its banner — the page's one
    // live region — announces it. No success toast on top (UX review L2:
    // the same news said twice).
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
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

// PR #392 review C3 — a decision whose response was lost is retried; the
// retry answers 409 `stage_changed` carrying the decision ALREADY recorded
// (contract § decision, "Idempotency"). When that is the member's own
// decision on this version, it was recorded: the success path, not an error.
describe('PR #392 review C3 — a repeated decision after a lost response', () => {
  const stageChanged = (recordedDecision: unknown) =>
    json(409, { error: { code: 'stage_changed', details: { stage: 'member_approved', status: 'member_approved', recordedDecision } } });

  it('the same decision on the same version is recorded: the dialog closes and the page refreshes, with no error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        stageChanged({ id: 'd-1', versionId: VERSION.id, decision: 'changes_requested', decidedAt: '2026-09-24T03:00:00.000Z', byCaller: true }),
      ),
    );
    renderActions();
    const { dialog, reason } = await openRequestChanges();
    fireEvent.change(reason, { target: { value: 'The date is wrong.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t.requestChanges.confirm }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(refresh).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ['a different decision', { id: 'd-1', versionId: VERSION.id, decision: 'approved', decidedAt: '2026-09-24T03:00:00.000Z' }],
    ['the same decision on an earlier version', { id: 'd-0', versionId: '33333333-3333-4333-8333-333333333333', decision: 'changes_requested', decidedAt: '2026-09-20T03:00:00.000Z' }],
    ['no recorded decision', null],
    // D6 — a colleague at the same member recorded the same decision on the
    // same version: this user's retry (and their typed reason) was NOT recorded.
    ['the same decision on the same version, recorded by a colleague', { id: 'd-1', versionId: VERSION.id, decision: 'changes_requested', decidedAt: '2026-09-24T03:00:00.000Z', byCaller: false }],
  ])('%s keeps the "already moved on" error', async (_label, recorded) => {
    vi.stubGlobal('fetch', vi.fn(async () => stageChanged(recorded)));
    renderActions();
    const { dialog, reason } = await openRequestChanges();
    fireEvent.change(reason, { target: { value: 'The date is wrong.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t.requestChanges.confirm }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.errors.stage_changed));
    expect(refresh).toHaveBeenCalled();
  });
});

// PR #392 review C1 — while READ_ONLY_MODE is on the proxy answers every
// write 503 with a FLAT `{ error: 'read-only-mode' }` (main #390).
describe('PR #392 review C1 — a decision refused by the read-only proxy', () => {
  // The dialog moves focus inside itself on open (Base UI initial focus), and
  // on a loaded runner that can land AFTER a refusal focused its alert — the
  // test acted within the open transition, faster than any user. Wait for the
  // open focus to settle first, as a user's own pace guarantees.
  const openFocusSettled = (dialog: HTMLElement) =>
    waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

  const readOnly503 = () =>
    new Response(JSON.stringify({ error: 'read-only-mode', message: 'read-only', retryAfterSeconds: 300 }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '300' },
    });

  // D4/D5 — the dialog stays open (nothing changed; a retry after the freeze
  // is still valid), so it is the ONE channel: the whole #390 warning (title
  // AND "nothing was changed") inside it, in the warning tone, focused. The
  // toast used to fire too — behind the modal, hidden from AT.
  it.each([
    [
      'Approve',
      async () => {
        fireEvent.click(screen.getByTestId('eblast-approve'));
        const dialog = await screen.findByRole('alertdialog');
        await openFocusSettled(dialog);
        fireEvent.click(within(dialog).getByTestId('eblast-approve-confirm'));
        return dialog;
      },
    ],
    [
      'Request changes',
      async () => {
        const { dialog, reason } = await openRequestChanges();
        await openFocusSettled(dialog);
        fireEvent.change(reason, { target: { value: 'The date is wrong.' } });
        fireEvent.click(within(dialog).getByRole('button', { name: t.requestChanges.confirm }));
        return dialog;
      },
    ],
  ])('%s: says the system is read-only inside the open dialog only — the warning, not the generic error, and no toast', async (_label, act) => {
    vi.stubGlobal('fetch', vi.fn(async () => readOnly503()));
    renderActions();
    const dialog = await act();

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(enMessages.errors.readOnlyMode);
    expect(alert).toHaveTextContent(enMessages.errors.readOnlyNothingChanged);
    expect(alert).toHaveAttribute('data-tone', 'warning');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(within(dialog).queryByText(t.errors.generic)).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('F119 UX review — sign-off dialogs while busy and after a refusal', () => {
  it('an identical refusal repeated is a NEW alert node, so it is announced again (M1)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { error: { code: 'broadcast_rate_limit_exceeded' } })));
    renderActions({ canDecide: false, canWithdrawApproval: true });
    fireEvent.click(screen.getByTestId('eblast-withdraw-approval'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText(t.withdrawApproval.reasonLabel), {
      target: { value: 'We found a typo in the date.' },
    });
    const confirm = within(dialog).getByRole('button', { name: t.withdrawApproval.confirm });
    fireEvent.click(confirm);
    const first = await within(dialog).findByRole('alert');
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'));

    fireEvent.click(confirm);
    await waitFor(() => expect(within(dialog).getByRole('alert')).not.toBe(first));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(t.errors.broadcast_rate_limit_exceeded);
  });

  it('Request changes is a normal step: an outline trigger and a primary Confirm; Withdraw approval stays destructive (M2)', async () => {
    renderActions();
    expect(screen.getByTestId('eblast-request-changes').className.split(' ')).not.toContain('text-destructive');
    fireEvent.click(screen.getByTestId('eblast-request-changes'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: t.requestChanges.confirm }).className).not.toContain('bg-destructive');
    fireEvent.click(within(dialog).getByRole('button', { name: t.requestChanges.cancel }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    cleanup();

    renderActions({ canDecide: false, canWithdrawApproval: true });
    // Positive control: the destructive tier really paints the trigger red.
    expect(screen.getByTestId('eblast-withdraw-approval').className.split(' ')).toContain('text-destructive');
    fireEvent.click(screen.getByTestId('eblast-withdraw-approval'));
    const withdraw = await screen.findByRole('alertdialog');
    expect(within(withdraw).getByRole('button', { name: t.withdrawApproval.confirm }).className).toContain('bg-destructive');
  });

  it('Approve: the note stays focusable (read-only) while busy, and a refusal is focused', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { answer = r; })));
    renderActions();
    fireEvent.click(screen.getByTestId('eblast-approve'));
    const dialog = await screen.findByRole('alertdialog');
    const note = within(dialog).getByLabelText(t.approveDialog.noteLabel);
    fireEvent.click(within(dialog).getByTestId('eblast-approve-confirm'));

    await waitFor(() => expect(within(dialog).getByTestId('eblast-approve-confirm')).toHaveAttribute('aria-busy', 'true'));
    expect(note).not.toBeDisabled();
    expect(note).toHaveAttribute('readonly');

    answer(json(429, { error: { code: 'broadcast_rate_limit_exceeded' } }));
    const alert = await within(dialog).findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it('Approve: the too-long note error sits immediately under the note (L4)', async () => {
    renderActions();
    fireEvent.click(screen.getByTestId('eblast-approve'));
    const dialog = await screen.findByRole('alertdialog');
    const note = within(dialog).getByLabelText(t.approveDialog.noteLabel);
    fireEvent.change(note, { target: { value: 'x'.repeat(501) } });
    expect(note.nextElementSibling).toHaveTextContent(t.approveDialog.noteTooLong);
  });
});
