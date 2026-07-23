/**
 * BulkActionBar — server error CODE mapped to localized copy (Cluster 6).
 *
 * A non-2xx / non-429 bulk response must be surfaced by branching on
 * `body.error.code` → a localized message, NEVER by rendering the server's
 * raw English `error.message` (the `state_error` message even embeds a member
 * UUID — see `bulk/route.ts`). Rendered against real en.json with a mocked
 * fetch. The Base UI dialogs are replaced with lightweight stand-ins so the
 * test drives `executeBulk()` without jsdom Base UI transition flakiness.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    info: (...a: unknown[]) => toastInfo(...a),
  },
}));

// Stand-in for the archive confirm dialog: a plain button that fires the
// component's `onConfirm` (== executeBulk('archive')) — avoids Base UI.
vi.mock('@/app/(staff)/admin/members/_components/archive-confirm-dialog', () => ({
  ArchiveConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => (
    <button type="button" data-testid="confirm-archive" onClick={() => onConfirm()}>
      confirm
    </button>
  ),
}));
vi.mock('@/app/(staff)/admin/members/_components/bulk-progress-indicator', () => ({
  BulkProgressIndicator: () => null,
}));
// Stand-in for the send-portal-invite confirm dialog: a plain button that
// fires the component's `onConfirm` (== executeBulk('send_portal_invite')).
vi.mock('@/components/shell/confirmation-dialog', () => ({
  ConfirmationDialog: ({ onConfirm }: { onConfirm: () => void }) => (
    <button type="button" data-testid="confirm-invite" onClick={() => onConfirm()}>
      confirm invite
    </button>
  ),
}));

import { BulkActionBar } from '@/app/(staff)/admin/members/_components/bulk-action-bar';

const MEMBER_UUID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  vi.useRealTimers();
  toastError.mockClear();
  toastSuccess.mockClear();
  toastInfo.mockClear();
});

function renderBar() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BulkActionBar
        selectedIds={[MEMBER_UUID]}
        selectedCompanyNames={['Acme Co']}
        totalMatching={1}
        onClear={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

describe('BulkActionBar — server error code mapping', () => {
  it('maps a 409 state_error to localized copy, never the raw server message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: 'state_error',
          // Deliberately HOSTILE fixture: the live route now sends a generic,
          // sanitized message (see bulk/route.ts state_error arm), but this mock
          // injects a raw UUID-bearing message to prove the client maps by
          // `code` and never echoes the server `message` — even if a future
          // regression (or an old deploy) were to leak one. Do NOT "sync" this
          // to the sanitized copy or the assertions below lose their teeth.
          message: `State transition failed for member ${MEMBER_UUID}.`,
          details: { member_id: MEMBER_UUID, code: 'state.already_archived' },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = renderBar();
    fireEvent.click(getByTestId('confirm-archive'));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const arg = toastError.mock.calls[0]?.[0] as string;
    expect(arg).toBe(
      "One or more selected members are in a state that doesn't allow this action. Refresh and try again.",
    );
    // The raw server message (with the UUID) must never reach the toast.
    expect(arg).not.toContain('State transition failed');
    expect(arg).not.toContain(MEMBER_UUID);

    vi.unstubAllGlobals();
  });

  it('falls back to the generic localized message for an unmapped code', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        error: { code: 'server_error', message: 'Internal server error.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = renderBar();
    fireEvent.click(getByTestId('confirm-archive'));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const arg = toastError.mock.calls[0]?.[0] as string;
    expect(arg).toBe('Something went wrong.');
    // Neither the raw message nor a dangling key path.
    expect(arg).not.toContain('Internal server error');
    expect(arg).not.toContain('errors.server_error');

    vi.unstubAllGlobals();
  });
});

describe('BulkActionBar — send_portal_invite result toast', () => {
  function mockBulkResult(counts: {
    invited: number;
    resent: number;
    skipped: number;
    failed: number;
  }) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        invited: [],
        resent: [],
        skipped: [],
        failed: [],
        counts,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('a resent-only run shows a SUCCESS toast (not the neutral "nothing happened" info)', async () => {
    // The bug this guards: with `else if (c.invited > 0)` a run that only
    // re-sent invitations (invited 0, resent > 0) fell through to toast.info,
    // telling the admin nothing happened while real emails were queued. The
    // success branch must include `c.resent > 0`.
    mockBulkResult({ invited: 0, resent: 2, skipped: 0, failed: 0 });

    const { getByTestId } = renderBar();
    fireEvent.click(getByTestId('confirm-invite'));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess.mock.calls[0]?.[0]).toContain('2 re-sent');

    vi.unstubAllGlobals();
  });

  it('a skipped-only run still shows the neutral INFO toast (unchanged branch)', async () => {
    // Locks the other side: an all-already-active run did nothing, so it must
    // stay a neutral info toast — the success condition must NOT over-broaden
    // to include skipped.
    mockBulkResult({ invited: 0, resent: 0, skipped: 3, failed: 0 });

    const { getByTestId } = renderBar();
    fireEvent.click(getByTestId('confirm-invite'));

    await waitFor(() => expect(toastInfo).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('BulkActionBar — bulk archive Undo', () => {
  it('archive success shows an Undo that restores exactly the server-returned ids', async () => {
    const archivedIds = ['aaaa-1', 'bbbb-2'];
    const fetchMock = vi
      .fn()
      // 1) the archive POST → returns the ids it archived
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ updated_count: 2, updated_ids: archivedIds }),
      })
      // 2) the Undo POST → unarchive
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ updated_count: 2 }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = renderBar();
    fireEvent.click(getByTestId('confirm-archive'));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [, opts] = toastSuccess.mock.calls[0] as [
      string,
      { action?: { label: string; onClick: () => void | Promise<void> } },
    ];
    expect(opts?.action?.label).toBe('Undo');

    // Invoking Undo posts `unarchive` with the RESPONSE ids (not the selection).
    await opts!.action!.onClick();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const undoBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as { body: string }).body,
    );
    expect(undoBody.action).toBe('unarchive');
    expect(undoBody.member_ids).toEqual(archivedIds);

    vi.unstubAllGlobals();
  });
});
