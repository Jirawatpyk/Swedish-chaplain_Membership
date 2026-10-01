/**
 * UX-A Bug 2 — `<PendingReactivationActions>` visibility gates.
 *
 * The component's correctness property is WHEN it offers the Approve /
 * Reject-&-refund actions. It must:
 *   - render BOTH actions for an UNMARKED `pending_admin_reactivation` cycle;
 *   - render NOTHING for a MARKED cycle (async reject-with-refund in flight —
 *     `rejectRefundInitiatedAt !== null`): the decision is already made, so
 *     offering Approve (which the route would 409 with
 *     `reject_refund_in_progress`) or Reject would overstate open work;
 *   - render NOTHING for any non-pending status.
 *
 * We assert by rendering the component + checking the TRIGGER buttons (which
 * live OUTSIDE the Base UI Dialog/AlertDialog, so probing them never opens a
 * dialog — opening one deadlocks under jsdom + React 19 startTransition, the
 * dialog-jsdom-hang precedent used by `cycle-admin-actions.test.tsx`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { PendingReactivationActions } from '@/app/(staff)/admin/renewals/[cycleId]/_components/pending-reactivation-actions';
import enMessages from '@/i18n/messages/en.json';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CYCLE_ID = '22222222-2222-2222-2222-222222222222';

function renderActions(args: {
  status: string;
  rejectRefundInitiatedAt: string | null;
}) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages as Record<string, unknown>}
    >
      <PendingReactivationActions
        cycleId={CYCLE_ID}
        status={args.status}
        rejectRefundInitiatedAt={args.rejectRefundInitiatedAt}
      />
    </NextIntlClientProvider>,
  );
}

describe('<PendingReactivationActions> — UX-A Bug 2 visibility gates', () => {
  beforeEach(() => {
    refreshMock.mockReset();
  });
  afterEach(() => cleanup());

  it('renders BOTH approve + reject actions for an UNMARKED pending cycle', () => {
    renderActions({
      status: 'pending_admin_reactivation',
      rejectRefundInitiatedAt: null,
    });
    expect(
      screen.getByRole('button', { name: 'Approve reactivation' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reject & refund' }),
    ).toBeInTheDocument();
  });

  it('renders NOTHING for a MARKED (refund-settling) pending cycle', () => {
    const { container } = renderActions({
      status: 'pending_admin_reactivation',
      rejectRefundInitiatedAt: '2026-04-05T00:00:00Z',
    });
    expect(
      screen.queryByRole('button', { name: 'Approve reactivation' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Reject & refund' }),
    ).not.toBeInTheDocument();
    // The component returns null → no DOM at all.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders NOTHING for a non-pending status', () => {
    const { container } = renderActions({
      status: 'completed',
      rejectRefundInitiatedAt: null,
    });
    expect(container).toBeEmptyDOMElement();
  });
});

// 122 US7b-1 (T723), board `Admin-renewal-cycle-pending`: "Approve
// reactivation" is the primary AURA button and "Reject & refund" the danger
// one; both confirm in AURA alertdialogs with the same requests.
describe('<PendingReactivationActions> on AURA', () => {
  const P = enMessages.admin.renewals.cycleDetail.pendingReactivation;

  // The suite runs on fake timers; the dialog flow awaits real ones.
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderPending() {
    return renderActions({ status: 'pending_admin_reactivation', rejectRefundInitiatedAt: null });
  }

  it('makes Approve reactivation primary and Reject & refund danger', () => {
    renderPending();
    expect(screen.getByRole('button', { name: P.reactivate.button })).toHaveClass('aura-btn--primary');
    expect(screen.getByRole('button', { name: P.reject.button })).toHaveClass('aura-btn--danger-secondary');
  });

  it('approves in an AURA alertdialog with the same empty POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    renderPending();
    fireEvent.click(screen.getByRole('button', { name: P.reactivate.button }));
    const dialog = screen.getByRole('alertdialog', { name: P.reactivate.dialogTitle });
    expect(dialog).toHaveClass('aura-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: P.reactivate.confirm }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/admin/renewals/${CYCLE_ID}/reactivate`);
    expect(init).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('rejects in an AURA alertdialog that needs a reason, posting it trimmed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ refund_credit_note_id: 'cn-1' }) });
    vi.stubGlobal('fetch', fetchMock);
    renderPending();
    fireEvent.click(screen.getByRole('button', { name: P.reject.button }));
    const dialog = screen.getByRole('alertdialog', { name: P.reject.dialogTitle });
    const confirm = within(dialog).getByRole('button', { name: P.reject.confirm });
    expect(confirm).toHaveClass('aura-btn--danger');
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: new RegExp(`^${P.reject.reasonLabel}`) }), {
      target: { value: '  Duplicate payment  ' },
    });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/admin/renewals/${CYCLE_ID}/reject`);
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'Duplicate payment' });
  });
});
