// @vitest-environment jsdom
/**
 * F119 T063 UX review — the staff writing surface for the working copy.
 *
 *   H2  a control that turns unavailable while it holds focus must keep it:
 *       Save / Send / the test copy are `aria-disabled` (Base UI
 *       `focusableWhenDisabled`), never native `disabled`, which drops focus to
 *       `<body>`. A FAILED send moves focus to what needs fixing — the field the
 *       refusal names, or Reload on a conflict — not to a trigger it disabled.
 *   M6  Reload says it discards the edits, and focus moves to it when the
 *       conflict appears.
 *   M7  a refusal renders UNDER the field it names (ux-standards § 4.1), with
 *       the field pointing at it; an unattributed one at the end of the form.
 *   LOW one feedback channel: a failed send is inline only (no toast).
 *   V8  (T086a) Enter in the subject saves the version, as Save does — the
 *       fields are a `<form>`; Enter in the body editor or the note never
 *       submits it.
 *
 * The editor, the live preview and the unsaved-changes guard are doubled —
 * this file pins the workspace's own wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { FormattedVersionWorkspace } from '@/components/broadcast/approval/formatted-version-workspace';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/components/shell/unsaved-changes-guard', () => ({ UnsavedChangesGuard: () => null }));
vi.mock('@/components/broadcast/preview-pane', () => ({ PreviewPane: () => null }));
vi.mock('@/components/broadcast/use-preview-html', () => ({ PreviewSurface: () => <div data-testid="preview-surface" /> }));
vi.mock('@/components/ui/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(props: {
      initialHtml: string;
      onChange: (html: string) => void;
      labelledById?: string;
      describedById?: string;
    }): React.ReactElement {
      return (
        <textarea
          data-testid="tiptap-editor"
          aria-labelledby={props.labelledById}
          aria-describedby={props.describedById}
          defaultValue={props.initialHtml}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
    },
}));

const ID = '11111111-1111-4111-8111-111111111111';
const t = enMessages.admin.broadcasts.approval;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const refusal = (status: number, code: string, fieldErrors?: Record<string, string[]>) =>
  jsonResponse(status, { error: { code, message: code, ...(fieldErrors ? { fieldErrors } : {}) } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useRealTimers();
  refresh.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.warning).mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderWorkspace() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <main id="main-content" tabIndex={-1}>
        <FormattedVersionWorkspace
          broadcastId={ID}
          workingCopy={{
            id: 'aaaaaaaa-0000-4000-8000-000000000001',
            versionNo: 1,
            subject: 'Formatted subject',
            bodyHtml: '<p>formatted</p>',
            noteToMember: null,
            updatedAt: '2026-09-20T08:00:00.000Z',
          }}
          original={{ subject: 'Original subject', preview: { status: 'ready', html: '<p>x</p>' } as never }}
          imagesEnabled={false}
        />
      </main>
    </NextIntlClientProvider>,
  );
}

const saveButton = () => screen.getByTestId('eblast-format-save');
const sendButton = () => screen.getByTestId('eblast-send-to-member');

async function sendAndConfirm(): Promise<void> {
  fireEvent.click(sendButton());
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByTestId('eblast-send-to-member-confirm'));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
}

describe('F119 T063 — the staff format workspace (UX review)', () => {
  it('H2: Save is aria-disabled (still focusable), never natively disabled, while there is nothing to save', () => {
    renderWorkspace();
    expect(saveButton()).not.toHaveAttribute('disabled');
    expect(saveButton()).toHaveAttribute('aria-disabled', 'true');
    // The hook the shared Button's `data-disabled:` dimmed look keys on.
    expect(saveButton()).toHaveAttribute('data-disabled');
    expect(screen.getByTestId('eblast-test-copy')).not.toHaveAttribute('disabled');
  });

  it('H2: a successful save keeps focus on Save (it turns aria-disabled, not disabled)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { version: { updatedAt: '2026-09-20T09:00:00.000Z' } }));
    renderWorkspace();
    fireEvent.change(screen.getByLabelText(t.workspace.subjectLabel), { target: { value: 'Edited' } });
    saveButton().focus();
    fireEvent.click(saveButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.workspace.saved));
    expect(saveButton()).toHaveAttribute('aria-disabled', 'true');
    expect(saveButton()).not.toHaveAttribute('disabled');
    expect(document.activeElement).toBe(saveButton());
  });

  it('M7: a subject refusal renders UNDER the subject, the subject points at it, and it carries the icon', async () => {
    fetchMock.mockResolvedValueOnce(refusal(422, 'validation_error', { subject: ['too long'] }));
    renderWorkspace();
    const subject = screen.getByLabelText(t.workspace.subjectLabel);
    fireEvent.change(subject, { target: { value: 'Edited' } });
    fireEvent.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t.errors.validation_error);
    expect(subject.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
    expect(subject).toHaveAttribute('aria-invalid', 'true');
    // Below the field: in the subject's own group, after the input.
    expect(subject.parentElement).toContainElement(alert);
    expect(subject.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.querySelector('svg')).not.toBeNull();
  });

  it('H2 + LOW: a send refused for its content closes the dialog, moves focus to the body error, and says it once (no toast)', async () => {
    fetchMock.mockResolvedValueOnce(refusal(422, 'unsafe_content'));
    renderWorkspace();
    await sendAndConfirm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t.errors.unsafe_content);
    expect(screen.getByTestId('tiptap-editor').getAttribute('aria-describedby')).toBe(alert.id);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(toast.error).not.toHaveBeenCalled();
    expect(sendButton()).not.toHaveAttribute('disabled');
  });

  it('H2: a send that fails with no field (network) lands focus on the form-level error at the end of the form', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    renderWorkspace();
    await sendAndConfirm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t.errors.generic);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('M6: a conflict on send focuses Reload, whose label says the edits are discarded; Send stays focusable', async () => {
    fetchMock.mockResolvedValueOnce(refusal(409, 'version_changed'));
    renderWorkspace();
    fireEvent.change(screen.getByLabelText(t.workspace.subjectLabel), { target: { value: 'Edited' } });
    await sendAndConfirm();

    const reload = await screen.findByRole('button', { name: t.workspace.reload });
    expect(t.workspace.reload).toMatch(/discard/i);
    await waitFor(() => expect(document.activeElement).toBe(reload));
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
    expect(sendButton()).not.toHaveAttribute('disabled');
  });

  it('M6: a conflict on Save also moves focus to Reload', async () => {
    fetchMock.mockResolvedValueOnce(refusal(409, 'version_changed'));
    renderWorkspace();
    fireEvent.change(screen.getByLabelText(t.workspace.subjectLabel), { target: { value: 'Edited' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    const reload = await screen.findByRole('button', { name: t.workspace.reload });
    await waitFor(() => expect(document.activeElement).toBe(reload));
  });
  // F119 round-4 B1 (FR-033) — Send carries the concurrency token, so a stale
  // screen cannot send content another marketing user saved unseen. When Send
  // saved first it is the token THAT save returned — the page-load token would
  // make the happy path answer 409 to itself.
  // PR #392 review C1 — the READ_ONLY_MODE freeze: the proxy's FLAT 503
  // `{ error: 'read-only-mode' }` is main #390's read-only warning, never the
  // generic "Something went wrong" line (and nothing was saved or sent).
  describe('PR #392 review C1 — the read-only proxy', () => {
    const readOnly503 = () => jsonResponse(503, { error: 'read-only-mode', message: 'read-only', retryAfterSeconds: 300 });
    const expectReadOnlyWarning = async () => {
      await waitFor(() =>
        expect(toast.warning).toHaveBeenCalledWith(enMessages.errors.readOnlyMode, {
          description: enMessages.errors.readOnlyNothingChanged,
        }),
      );
      expect(toast.error).not.toHaveBeenCalled();
      expect(screen.queryByText(t.errors.generic)).toBeNull();
    };

    it('Save says the system is read-only', async () => {
      fetchMock.mockResolvedValueOnce(readOnly503());
      renderWorkspace();
      fireEvent.change(screen.getByLabelText(t.workspace.subjectLabel), { target: { value: 'Edited' } });
      fireEvent.click(saveButton());
      await expectReadOnlyWarning();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('Send — clean, the send itself refused — closes the dialog and says the system is read-only', async () => {
      fetchMock.mockResolvedValueOnce(readOnly503());
      renderWorkspace();
      await sendAndConfirm();
      await expectReadOnlyWarning();
      expect(refresh).not.toHaveBeenCalled();
    });

    it('Send — dirty, its save refused — closes the dialog, says the system is read-only, and sends nothing', async () => {
      fetchMock.mockResolvedValueOnce(readOnly503());
      renderWorkspace();
      fireEvent.change(screen.getByLabelText(t.workspace.subjectLabel), { target: { value: 'Edited' } });
      await sendAndConfirm();
      await expectReadOnlyWarning();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('round-4 B1 — the send carries expectedUpdatedAt', () => {
    const sendBody = (): Record<string, unknown> => {
      const call = fetchMock.mock.calls.find(([url]) => url === `/api/admin/broadcasts/${ID}/version/send`) as
        | [string, RequestInit]
        | undefined;
      expect(call).toBeDefined();
      expect(call![1].method).toBe('POST');
      return JSON.parse(String(call![1].body)) as Record<string, unknown>;
    };

    it('dirty: the save runs first and the send carries the updatedAt that save returned', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { version: { updatedAt: '2026-09-20T09:30:00.000Z' } }))
        .mockResolvedValueOnce(jsonResponse(200, { stage: 'awaiting_member_approval' }));
      renderWorkspace();
      fireEvent.change(screen.getByLabelText(t.workspace.subjectLabel), { target: { value: 'Edited' } });
      await sendAndConfirm();
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.send.sent));
      expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe('PATCH');
      expect(sendBody()).toEqual({ expectedUpdatedAt: '2026-09-20T09:30:00.000Z' });
    });

    it('clean: the send carries the updatedAt the screen loaded', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { stage: 'awaiting_member_approval' }));
      renderWorkspace();
      await sendAndConfirm();
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.send.sent));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sendBody()).toEqual({ expectedUpdatedAt: '2026-09-20T08:00:00.000Z' });
    });

    it('saved earlier, then sent clean: the send carries the token of that earlier save', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { version: { updatedAt: '2026-09-20T10:00:00.000Z' } }))
        .mockResolvedValueOnce(jsonResponse(200, { stage: 'awaiting_member_approval' }));
      renderWorkspace();
      fireEvent.change(screen.getByLabelText(t.workspace.subjectLabel), { target: { value: 'Edited' } });
      fireEvent.click(saveButton());
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.workspace.saved));
      await sendAndConfirm();
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.send.sent));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sendBody()).toEqual({ expectedUpdatedAt: '2026-09-20T10:00:00.000Z' });
    });
  });

  it('V8: Enter in the subject field saves the version, as the Save button does', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { version: { updatedAt: '2026-09-20T09:00:00.000Z' } }));
    const user = userEvent.setup();
    renderWorkspace();
    await user.type(screen.getByLabelText(t.workspace.subjectLabel), ' edited{Enter}');

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.workspace.saved));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`/api/admin/broadcasts/${ID}/version`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body)).subject).toBe('Formatted subject edited');
  });

  it('V8: Enter with nothing changed saves nothing (Save is unavailable)', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.type(screen.getByLabelText(t.workspace.subjectLabel), '{Enter}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('V8: Enter inside the body editor or the note never submits', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.type(screen.getByTestId('tiptap-editor'), 'more{Enter}');
    await user.type(screen.getByLabelText(t.workspace.noteLabel), 'a note{Enter}');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
