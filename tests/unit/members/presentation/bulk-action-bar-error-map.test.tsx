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
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a), info: vi.fn() },
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
vi.mock('@/components/shell/confirmation-dialog', () => ({
  ConfirmationDialog: () => null,
}));

import { BulkActionBar } from '@/app/(staff)/admin/members/_components/bulk-action-bar';

const MEMBER_UUID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  vi.useRealTimers();
  toastError.mockClear();
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
