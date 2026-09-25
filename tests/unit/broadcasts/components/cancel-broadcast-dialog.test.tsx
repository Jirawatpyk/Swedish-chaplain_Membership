// tests/unit/broadcasts/components/cancel-broadcast-dialog.test.tsx
/**
 * DV-12 — Unit tests for <CancelBroadcastDialog> (thin wrapper over the shared
 * <ReasonConfirmationDialog>).
 *
 * Pattern: real NextIntlClientProvider + real en.json, mock fetch +
 * sonner + next/navigation. Real timers (global setup uses fake timers
 * which hang waitFor). fireEvent for click/type (mirrors
 * resend-verification-button.test.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { CancelBroadcastDialog } from '@/components/broadcast/cancel-broadcast-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

// ── helpers ────────────────────────────────────────────────────────────

function renderAdmin(extra: Partial<React.ComponentProps<typeof CancelBroadcastDialog>> = {}) {
  const onOpenChange = extra.onOpenChange ?? vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <CancelBroadcastDialog
        open
        onOpenChange={onOpenChange}
        endpoint="/api/admin/broadcasts/b1/cancel"
        namespace="admin.broadcasts.cancelDialog"
        toastNamespace="admin.broadcasts.toast"
        reasonRequired
        subject={SUBJECT}
        {...extra}
      />
    </NextIntlClientProvider>,
  );
  return { onOpenChange };
}

function renderMember(
  extra: Partial<React.ComponentProps<typeof CancelBroadcastDialog>> = {},
) {
  const onOpenChange = extra.onOpenChange ?? vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <CancelBroadcastDialog
        open
        onOpenChange={onOpenChange}
        endpoint="/api/broadcasts/b1/cancel"
        namespace="portal.broadcasts.detail.cancelDialog"
        toastNamespace="portal.broadcasts.detail.toast"
        reasonRequired={false}
        subject={SUBJECT}
        {...extra}
      />
    </NextIntlClientProvider>,
  );
  return { onOpenChange };
}

// "Reason (optional)" contains parens — escape for use in a RegExp matcher.
const MEMBER_REASON_LABEL = new RegExp(
  en.portal.broadcasts.detail.cancelDialog.reasonLabel.replace(/[()]/g, '\\$&'),
  'i',
);

// U35 — cancelling is irreversible, so confirm is gated on typing the
// E-Blast's SUBJECT (maintainer decision), on both surfaces.
const ADMIN = en.admin.broadcasts.cancelDialog;
const MEMBER = en.portal.broadcasts.detail.cancelDialog;
const SUBJECT = 'Spring mixer — 2026 edition';

function phraseInput(ns: { subjectLabel: string }): HTMLElement {
  return screen.getByLabelText(ns.subjectLabel);
}

function typePhrase(ns: { subjectLabel: string }, value: string = SUBJECT): void {
  fireEvent.change(phraseInput(ns), { target: { value } });
}

// ── timer + mock lifecycle ──────────────────────────────────────────────

beforeEach(() => {
  // Real timers required: global setup enables fake timers (setTimeout faked);
  // waitFor() + Promise resolution needs real timers. Mirror:
  // tests/unit/components/members/resend-verification-button.test.tsx
  vi.useRealTimers();
  refreshSpy.mockClear();
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
  (toast.error as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  cleanup();
  // Restore the per-test fetch spy so its impl never leaks into a later test
  // (the global afterEach only clearAllMocks — call history, not the spy impl).
  // Safe: restoreAllMocks restores vi.spyOn spies only; it does not un-register
  // the vi.mock factories for sonner / next-navigation.
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

// ── Admin (reasonRequired=true) ─────────────────────────────────────────

describe('CancelBroadcastDialog (admin, reasonRequired=true)', () => {
  it('shows the dialog title when open', () => {
    renderAdmin();
    expect(
      screen.getByText(en.admin.broadcasts.cancelDialog.title),
    ).toBeInTheDocument();
  });

  it('submit disabled when reason is empty', () => {
    renderAdmin();
    const confirmBtn = screen.getByRole('button', {
      name: en.admin.broadcasts.cancelDialog.confirm,
    });
    expect(confirmBtn).toBeDisabled();
  });

  it('auto-focuses the reason textarea on open (admin/required path)', async () => {
    // reasonRequired=true → the shared dialog double-RAFs an imperative
    // textarea.focus(); jsdom's real RAF + .focus() DO set document.activeElement
    // for the attached textarea (unlike Base UI's portal initialFocus). This is a
    // real focus assertion for the admin path (the member path is covered
    // structurally below + by e2e @a11y).
    renderAdmin();
    const textarea = screen.getByLabelText(
      new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
    );
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it('confirm stays disabled and does NOT fetch when reason is empty (no inline error — disabled-button UX)', () => {
    // The required-reason rule is enforced by DISABLING confirm, not by an
    // inline "reason required" error. Assert: confirm disabled, NO alert (the
    // only inline alert is reasonTooLong, gated on over-cap), and no request.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    renderAdmin();
    expect(
      screen.getByRole('button', {
        name: en.admin.broadcasts.cancelDialog.confirm,
      }),
    ).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('success path: toasts cancelled + calls onOpenChange(false) + router.refresh', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
    const onOpenChange = vi.fn();
    renderAdmin({ onOpenChange });
    const textarea = screen.getByLabelText(
      new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
    );
    fireEvent.change(textarea, { target: { value: 'duplicate send' } });
    typePhrase(ADMIN);
    fireEvent.click(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        en.admin.broadcasts.toast.cancelled,
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refreshSpy).toHaveBeenCalled();
  });

  // Whole-branch review HIGH-2 — T081 answers `sending_started` for a row
  // already sending; the legacy code still answers for a closed E-Blast.
  it.each(['broadcast_cancel_too_late', 'sending_started'])('409 %s → toasts cancelTooLate', async (code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code } }),
    } as unknown as Response);
    renderAdmin();
    fireEvent.change(
      screen.getByLabelText(
        new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
      ),
      { target: { value: 'x' } },
    );
    typePhrase(ADMIN);
    fireEvent.click(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        en.admin.broadcasts.toast.cancelTooLate,
      ),
    );
  });

  it('409 broadcast_concurrent_action_blocked → toasts concurrentRace + closes dialog', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'broadcast_concurrent_action_blocked' } }),
    } as unknown as Response);
    const onOpenChange = vi.fn();
    renderAdmin({ onOpenChange });
    fireEvent.change(
      screen.getByLabelText(
        new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
      ),
      { target: { value: 'x' } },
    );
    typePhrase(ADMIN);
    fireEvent.click(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        en.admin.broadcasts.toast.concurrentRace,
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // F119 UX review H1 — a refusal that keeps the dialog open is said INSIDE
  // it (ux-standards § 6.4): a toast renders outside the modal, which hides
  // everything outside itself from AT.
  it('non-409 server error → cancelError inline in the open dialog, not a toast', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);
    renderAdmin();
    fireEvent.change(
      screen.getByLabelText(
        new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
      ),
      { target: { value: 'y' } },
    );
    typePhrase(ADMIN);
    fireEvent.click(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    );
    const alert = await within(screen.getByRole('alertdialog')).findByText(en.admin.broadcasts.toast.cancelError);
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('network throw → cancelError inline, dialog kept open for retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const onOpenChange = vi.fn();
    renderMember({ onOpenChange });
    typePhrase(MEMBER);
    fireEvent.click(screen.getByRole('button', { name: MEMBER.confirm }));
    const alert = await within(screen.getByRole('alertdialog')).findByText(
      en.portal.broadcasts.detail.toast.cancelError,
    );
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('trims the reason before sending (whitespace not persisted to the audit)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
    renderAdmin();
    fireEvent.change(
      screen.getByLabelText(
        new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
      ),
      { target: { value: '  duplicate send  ' } },
    );
    typePhrase(ADMIN);
    fireEvent.click(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const sent = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(sent).toEqual({ cancellationReason: 'duplicate send' });
  });

  it('404 (broadcast gone / cross-member) → toasts cancelError + CLOSES + refresh (permanent)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'broadcast_not_found' } }),
    } as unknown as Response);
    const onOpenChange = vi.fn();
    renderAdmin({ onOpenChange });
    fireEvent.change(
      screen.getByLabelText(
        new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
      ),
      { target: { value: 'x' } },
    );
    typePhrase(ADMIN);
    fireEvent.click(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.broadcasts.toast.cancelError),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('5xx transient → cancelError inline and KEEPS the dialog open (no close/refresh)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);
    const onOpenChange = vi.fn();
    renderAdmin({ onOpenChange });
    fireEvent.change(
      screen.getByLabelText(
        new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
      ),
      { target: { value: 'y' } },
    );
    typePhrase(ADMIN);
    fireEvent.click(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    );
    await within(screen.getByRole('alertdialog')).findByText(en.admin.broadcasts.toast.cancelError);
    expect(toast.error).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('reason > 500 chars → shows reasonTooLong inline error + confirm stays disabled', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    renderAdmin();
    const textarea = screen.getByLabelText(
      new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
    );
    fireEvent.change(textarea, { target: { value: 'a'.repeat(501) } });
    expect(
      screen.getByRole('alert'),
    ).toHaveTextContent(en.admin.broadcasts.cancelDialog.errors.reasonTooLong);
    expect(
      screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }),
    ).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Member (reasonRequired=false) ───────────────────────────────────────

describe('CancelBroadcastDialog (member, reasonRequired=false)', () => {
  it('member path wires Cancel as the initial-focus target and does NOT auto-focus the textarea', () => {
    // reasonRequired=false → the shared dialog hands initial focus to the Cancel
    // ("Keep it") button via Base UI `initialFocus={cancelRef}` and SKIPS the
    // textarea auto-focus RAF. Base UI's portal focus machinery does not fire a
    // real focus event under jsdom, so we cannot assert toHaveFocus() on the
    // Cancel button here (covered by e2e @a11y on preview). What we CAN assert
    // deterministically: the Cancel button is the wired target (present + not
    // disabled) AND the textarea is NOT auto-focused (proving the required-path
    // RAF was correctly skipped for the optional path).
    renderMember();
    const cancelBtn = screen.getByRole('button', {
      name: en.portal.broadcasts.detail.cancelDialog.cancel,
    });
    expect(cancelBtn).toBeInTheDocument();
    expect(cancelBtn).not.toBeDisabled();
    expect(screen.getByLabelText(MEMBER_REASON_LABEL)).not.toHaveFocus();
  });

  it('shows the member dialog title when open', () => {
    renderMember();
    expect(
      screen.getByText(en.portal.broadcasts.detail.cancelDialog.title),
    ).toBeInTheDocument();
  });

  it('confirm enabled with an empty reason (optional) once the phrase is typed', () => {
    renderMember();
    typePhrase(MEMBER);
    expect(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    ).not.toBeDisabled();
  });

  it('member success with empty reason → toasts cancelled + onOpenChange(false) + router.refresh', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
    const onOpenChange = vi.fn();
    renderMember({ onOpenChange });
    typePhrase(MEMBER);
    fireEvent.click(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        en.portal.broadcasts.detail.toast.cancelled,
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('member reason > 500 chars → shows reasonTooLong + confirm disabled', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    renderMember();
    const textarea = screen.getByLabelText(MEMBER_REASON_LABEL);
    fireEvent.change(textarea, { target: { value: 'b'.repeat(501) } });
    expect(
      screen.getByRole('alert'),
    ).toHaveTextContent(en.portal.broadcasts.detail.cancelDialog.errors.reasonTooLong);
    expect(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    ).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['broadcast_cancel_too_late', 'sending_started'])('member 409 %s → toasts cancelTooLate', async (code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code } }),
    } as unknown as Response);
    renderMember();
    typePhrase(MEMBER);
    fireEvent.click(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        en.portal.broadcasts.detail.toast.cancelTooLate,
      ),
    );
  });

  it('member 409 concurrent → toasts concurrentRace', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'broadcast_concurrent_action_blocked' } }),
    } as unknown as Response);
    renderMember();
    typePhrase(MEMBER);
    fireEvent.click(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        en.portal.broadcasts.detail.toast.concurrentRace,
      ),
    );
  });
});

// ── Typed-subject gate (U35) ────────────────────────────────────────────

describe('CancelBroadcastDialog — typed-subject gate (U35)', () => {
  const adminConfirm = () => screen.getByRole('button', { name: ADMIN.confirm });
  const memberConfirm = () => screen.getByRole('button', { name: MEMBER.confirm });

  it('staff: a valid reason alone does not enable confirm, nor does the old fixed word', () => {
    renderAdmin();
    fireEvent.change(screen.getByLabelText(new RegExp(ADMIN.reasonLabel, 'i')), {
      target: { value: 'duplicate send' },
    });
    expect(adminConfirm()).toBeDisabled();
    typePhrase(ADMIN, ADMIN.phrase);
    expect(adminConfirm()).toBeDisabled();
    typePhrase(ADMIN);
    expect(adminConfirm()).not.toBeDisabled();
  });

  it('member: confirm is disabled until the subject matches; the old fixed word does not unlock it', () => {
    renderMember();
    expect(memberConfirm()).toBeDisabled();
    typePhrase(MEMBER, MEMBER.phrase);
    expect(memberConfirm()).toBeDisabled();
    typePhrase(MEMBER);
    expect(memberConfirm()).not.toBeDisabled();
  });

  it('shows the whole subject as the copy target, with a Copy subject button and help text', () => {
    renderMember();
    expect(screen.getByText(SUBJECT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: MEMBER.copySubject })).toBeInTheDocument();
    expect(screen.getByText(MEMBER.phraseHelp)).toBeInTheDocument();
  });

  it('matches case-, whitespace- and punctuation-insensitively', () => {
    renderMember();
    typePhrase(MEMBER, '  spring   MIXER 2026 edition ');
    expect(memberConfirm()).not.toBeDisabled();
  });

  it('a paste of the subject enables confirm', async () => {
    const user = userEvent.setup();
    renderMember();
    await user.click(phraseInput(MEMBER));
    await user.paste(SUBJECT);
    expect(phraseInput(MEMBER)).toHaveValue(SUBJECT);
    expect(memberConfirm()).not.toBeDisabled();
  });

  it('a 200-character subject is shown in full, wrapped', () => {
    const long = 'Annual members meeting '.repeat(9).slice(0, 200);
    renderAdmin({ subject: long });
    const target = screen.getByText(long.trim());
    expect(target.textContent).toBe(long);
    expect(target.className).toMatch(/(^|\s)whitespace-pre-wrap(\s|$)/);
    expect(target.className).toMatch(/(^|\s)break-words(\s|$)/);
  });

  it('a subject that normalises to empty falls back to the fixed word', () => {
    renderMember({ subject: '!!! — ???' });
    const fallback = screen.getByLabelText(
      MEMBER.phraseLabel.replace('{phrase}', MEMBER.phrase),
    );
    // Typing the (empty-normalising) subject itself must NOT pass the gate.
    fireEvent.change(fallback, { target: { value: '!!! — ???' } });
    expect(memberConfirm()).toBeDisabled();
    fireEvent.change(fallback, { target: { value: MEMBER.phrase } });
    expect(memberConfirm()).not.toBeDisabled();
    // "Copy subject" would be a lie here.
    expect(screen.queryByRole('button', { name: MEMBER.copySubject })).toBeNull();
  });

  it('a mismatch keeps confirm disabled, announces the error once blurred and does not fetch', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderMember();
    typePhrase(MEMBER, 'Spring');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(phraseInput(MEMBER));
    expect(memberConfirm()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(MEMBER.subjectError);
    expect(phraseInput(MEMBER)).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(memberConfirm());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Enter in the subject input confirms once it matches, not before', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    renderMember();
    typePhrase(MEMBER, 'Spring');
    fireEvent.keyDown(phraseInput(MEMBER), { key: 'Enter' });
    expect(fetchSpy).not.toHaveBeenCalled();
    typePhrase(MEMBER);
    fireEvent.keyDown(phraseInput(MEMBER), { key: 'Enter' });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  });

  it('a re-opened dialog starts with an empty phrase', () => {
    const el = (open: boolean) => (
      <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
        <CancelBroadcastDialog
          open={open}
          onOpenChange={vi.fn()}
          endpoint="/api/broadcasts/b1/cancel"
          namespace="portal.broadcasts.detail.cancelDialog"
          toastNamespace="portal.broadcasts.detail.toast"
          reasonRequired={false}
          subject={SUBJECT}
        />
      </NextIntlClientProvider>
    );
    const { rerender } = render(el(true));
    typePhrase(MEMBER);
    rerender(el(false));
    rerender(el(true));
    expect(phraseInput(MEMBER)).toHaveValue('');
  });
});

// ── Reset-on-open (review fix #1) ────────────────────────────────────────

describe('CancelBroadcastDialog — reset on open', () => {
  const reasonLabel = new RegExp(
    en.admin.broadcasts.cancelDialog.reasonLabel,
    'i',
  );
  const adminEl = (open: boolean) => (
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <CancelBroadcastDialog
        open={open}
        onOpenChange={vi.fn()}
        endpoint="/api/admin/broadcasts/b1/cancel"
        namespace="admin.broadcasts.cancelDialog"
        toastNamespace="admin.broadcasts.toast"
        reasonRequired
        subject={SUBJECT}
      />
    </NextIntlClientProvider>
  );

  it('a re-opened dialog starts with an empty reason (programmatic close bypasses Base UI onOpenChange)', () => {
    const { rerender } = render(adminEl(true));
    fireEvent.change(screen.getByLabelText(reasonLabel), {
      target: { value: 'stale reason from a prior attempt' },
    });
    expect(screen.getByLabelText(reasonLabel)).toHaveValue(
      'stale reason from a prior attempt',
    );
    // Success / 409 close the dialog by calling onOpenChange(false) directly —
    // simulate that programmatic close, then re-open.
    rerender(adminEl(false));
    rerender(adminEl(true));
    expect(screen.getByLabelText(reasonLabel)).toHaveValue('');
  });
});
