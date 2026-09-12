/**
 * F114 T089 — the withdraw control on `PendingRequestBanner` (US5 AS1;
 * FR-009 "after a standard confirmation"; FR-034 live region).
 *
 * The shared `ConfirmationDialog` is replaced with a lightweight stand-in
 * (the bulk-action-bar precedent) so this test drives the BANNER's contract:
 *   - "Withdraw request" opens the dialog with the withdraw copy, the
 *     NON-destructive tier (nothing is destroyed — nothing was applied);
 *   - Confirm → `DELETE /api/portal/change-requests/current`; a 200 swaps the
 *     banner for a `role="status"` "withdrawn" message (announced, and the
 *     diff table + the withdraw button are gone);
 *   - a 404 (`no_pending_request` — decided or withdrawn meanwhile) shows the
 *     "gone" message and refreshes the server state;
 *   - a 5xx keeps the banner and announces the error inline (no toast);
 *   - Cancel leaves everything untouched and calls nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

type DialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
};
const dialogProps: DialogProps[] = [];
vi.mock('@/components/shell/confirmation-dialog', () => ({
  ConfirmationDialog: (props: DialogProps) => {
    dialogProps.push(props);
    if (!props.open) return null;
    return (
      <div data-testid="dialog-stand-in">
        <p>{props.title}</p>
        <p>{props.description}</p>
        <button type="button" onClick={() => props.onOpenChange(false)}>
          {props.cancelLabel}
        </button>
        <button
          type="button"
          onClick={() => {
            void Promise.resolve(props.onConfirm()).then(() => props.onOpenChange(false));
          }}
        >
          {props.confirmLabel}
        </button>
      </div>
    );
  },
}));

import { PendingRequestBanner } from '@/components/members/change-requests/pending-request-banner';

const copy = enMessages.portal.changeRequests;

const pending = {
  id: '00000000-0000-4000-8000-000000000001',
  memberId: '11111111-1111-4111-8111-111111111111',
  scope: 'own_contact',
  state: 'pending',
  outcome: null,
  withdrawnReason: null,
  submittedAt: '2026-09-11T08:00:00.000Z',
  decidedAt: null,
  decidedBy: 'organisation',
  decisionReason: null,
  outcomeAcknowledgedAt: null,
  submittedBy: { contactId: 'c-1', displayName: 'Anna Svensson', isMe: true },
  fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: null, appliedAt: null }],
} as unknown as ChangeRequestView;

const fetchMock = vi.fn();

function renderBanner() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PendingRequestBanner request={pending} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  // the shared setup installs fake timers; `waitFor` needs real ones
  vi.useRealTimers();
  dialogProps.length = 0;
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('PendingRequestBanner — withdraw (T089)', () => {
  it('opens the confirmation with the withdraw copy in the non-destructive tier; Cancel calls nothing', () => {
    renderBanner();
    expect(screen.getByTestId('pending-request-banner')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.button }));
    const open = dialogProps.at(-1)!;
    expect(open.open).toBe(true);
    expect(open.title).toBe(copy.withdraw.title);
    expect(open.description).toBe(copy.withdraw.description);
    expect(open.confirmLabel).toBe(copy.withdraw.confirm);
    expect(open.cancelLabel).toBe(copy.withdraw.cancel);
    expect(open.destructive).toBeFalsy();
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.cancel }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('pending-request-banner')).toBeTruthy();
  });

  it('Confirm → DELETE …/current; a 200 replaces the banner with an announced "withdrawn" status', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ request: { ...pending, state: 'withdrawn', withdrawnReason: 'member' } }), { status: 200 }));
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.button }));
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.confirm }));
    await waitFor(() => expect(screen.getByTestId('withdraw-result')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/portal/change-requests/current', expect.objectContaining({ method: 'DELETE' }));
    const result = screen.getByTestId('withdraw-result');
    expect(result.getAttribute('role')).toBe('status');
    expect(result.textContent).toContain(copy.withdraw.done);
    expect(screen.queryByTestId('pending-request-banner')).toBeNull();
    expect(screen.queryByRole('button', { name: copy.withdraw.button })).toBeNull();
    // the server tree is refreshed too, so /portal/edit's form + hint stop
    // describing a request that no longer exists (review round 1, UX C2)
    expect(refresh).toHaveBeenCalled();
  });

  it('READ_ONLY_MODE (503) is its own message, not "please try again" (review round 1, UX S13)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'read_only_mode' } }), { status: 503 }));
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.button }));
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.confirm }));
    await waitFor(() => expect(screen.getByTestId('withdraw-error')).toBeTruthy());
    expect(screen.getByTestId('withdraw-error').textContent).toContain(copy.withdraw.readOnly);
  });

  it('a 404 no_pending_request (decided or withdrawn meanwhile) shows the "gone" message and refreshes the server state', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no_pending_request' }), { status: 404 }));
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.button }));
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.confirm }));
    await waitFor(() => expect(screen.getByTestId('withdraw-result')).toBeTruthy());
    expect(screen.getByTestId('withdraw-result').textContent).toContain(copy.withdraw.gone);
    expect(refresh).toHaveBeenCalled();
  });

  it('a 5xx keeps the banner and announces the error inline', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'server_error' }), { status: 500 }));
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.button }));
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.confirm }));
    await waitFor(() => expect(screen.getByTestId('withdraw-error')).toBeTruthy());
    expect(screen.getByTestId('pending-request-banner')).toBeTruthy();
    expect(screen.getByTestId('withdraw-error').textContent).toContain(copy.withdraw.error);
    expect(screen.getByRole('button', { name: copy.withdraw.button })).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a network failure is the same inline error, logged to the console (never swallowed)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.button }));
    fireEvent.click(screen.getByRole('button', { name: copy.withdraw.confirm }));
    await waitFor(() => expect(screen.getByTestId('withdraw-error')).toBeTruthy());
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
