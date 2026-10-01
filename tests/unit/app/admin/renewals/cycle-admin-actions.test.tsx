/**
 * DV-5 — `<CycleAdminActions>` visibility-gate tests.
 *
 * The component's key correctness property is its per-status visibility gates:
 * it must NOT offer an action the route would reject (cancel only for
 * upcoming/reminded/awaiting_payment; mark-paid only for upcoming/
 * awaiting_payment; nothing for terminal + pending_admin_reactivation). We
 * assert the gates by rendering the component — the trigger Buttons live
 * OUTSIDE the Base UI Dialog, so checking their presence does NOT open a
 * dialog.
 *
 * Endpoint+body wiring is NOT asserted by opening a dialog here: opening a
 * Base UI Dialog/AlertDialog under jsdom + React 19 `startTransition`
 * deadlocks (the dialog-jsdom-hang memory — confirmed: a click-to-open + fill
 * + confirm flow times out at 30s in this repo). The endpoint shape is pinned
 * two other ways instead:
 *   - `cycle-admin-error-i18n.test.ts` — the error-code lists the component
 *     maps to toasts are kept in lock-step with the route `switch` arms + the
 *     EN i18n keys (the mock-next-intl / parity-only `check:i18n` blind spot).
 *   - the routes themselves (`cancel/route.ts`, `mark-paid-offline/route.ts`)
 *     are pre-existing + independently tested.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { CycleAdminActions } from '@/app/(staff)/admin/renewals/[cycleId]/_components/cycle-admin-actions';
import type { CycleStatus } from '@/modules/renewals';
import enMessages from '@/i18n/messages/en.json';

const refreshMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: pushMock }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CYCLE_ID = '11111111-1111-1111-1111-111111111111';

function renderActions(
  status: CycleStatus,
  liveLinkedBill: {
    readonly invoiceId: string;
    readonly billNumber: string | null;
  } | null = null,
  placement: 'header' | 'dangerZone' = 'header',
) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages as Record<string, unknown>}
    >
      <CycleAdminActions
        cycleId={CYCLE_ID}
        status={status}
        liveLinkedBill={liveLinkedBill}
        placement={placement}
      />
    </NextIntlClientProvider>,
  );
}

describe('<CycleAdminActions> — DV-5 visibility gates', () => {
  beforeEach(() => {
    refreshMock.mockReset();
    pushMock.mockReset();
  });
  afterEach(() => cleanup());

  it.each<CycleStatus>(['upcoming', 'awaiting_payment'])(
    'renders BOTH cancel + mark-paid controls for status=%s',
    (status) => {
      renderActions(status);
      expect(
        screen.getByRole('button', { name: 'Cancel cycle' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Mark paid offline' }),
      ).toBeInTheDocument();
    },
  );

  it('renders ONLY the cancel control for status=reminded (not payable)', () => {
    renderActions('reminded');
    expect(
      screen.getByRole('button', { name: 'Cancel cycle' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark paid offline' }),
    ).not.toBeInTheDocument();
  });

  it.each<CycleStatus>([
    'completed',
    'lapsed',
    'cancelled',
    'pending_admin_reactivation',
  ])('renders NOTHING for terminal/pending status=%s', (status) => {
    const { container } = renderActions(status);
    expect(
      screen.queryByRole('button', { name: 'Cancel cycle' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark paid offline' }),
    ).not.toBeInTheDocument();
    // The component returns null → no DOM at all.
    expect(container).toBeEmptyDOMElement();
  });
});

// A payable cycle that already has a live linked bill (SC-…) — e.g. an
// `awaiting_payment` cycle after the member confirmed early. Mark-paid-offline
// would be refused by the use-case (`membership_bill_already_exists`), so the
// page offers the F4 Record-payment path on that bill instead.
describe('<CycleAdminActions> — cycle with a live linked bill', () => {
  const INVOICE_ID = '22222222-2222-2222-2222-222222222222';
  afterEach(() => cleanup());

  it.each<CycleStatus>(['upcoming', 'awaiting_payment'])(
    'shows "Record payment on {billNumber}" instead of Mark paid offline (status=%s)',
    (status) => {
      renderActions(status, {
        invoiceId: INVOICE_ID,
        billNumber: 'SC-2026-000412',
      });
      expect(
        screen.queryByRole('button', { name: 'Mark paid offline' }),
      ).not.toBeInTheDocument();
      const link = screen.getByRole('link', {
        name: 'Record payment on SC-2026-000412',
      });
      expect(link).toHaveAttribute('href', `/admin/invoices/${INVOICE_ID}`);
      // Cancel stays available — only the mint-and-pay path is swapped.
      expect(
        screen.getByRole('button', { name: 'Cancel cycle' }),
      ).toBeInTheDocument();
    },
  );

  it('falls back to a generic label when the bill number is unknown', () => {
    renderActions('awaiting_payment', { invoiceId: INVOICE_ID, billNumber: null });
    expect(
      screen.getByRole('link', { name: 'Record payment on the invoice' }),
    ).toHaveAttribute('href', `/admin/invoices/${INVOICE_ID}`);
  });

  it('offers neither for a non-payable status even with a linked bill', () => {
    renderActions('reminded', {
      invoiceId: INVOICE_ID,
      billNumber: 'SC-2026-000412',
    });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark paid offline' }),
    ).not.toBeInTheDocument();
  });
});

// 122 US7b-1 (T722), board `Admin-renewal-cycle` (+ `-mobile`): the actions
// sit in the page header — the payment action primary, Cancel cycle in the
// danger style — and on a phone Cancel cycle moves to the danger zone at the
// end of the page. The cancel confirm is an AURA alertdialog with the same
// reason and request.
describe('<CycleAdminActions> on AURA', () => {
  const C = enMessages.admin.renewals.cycleDetail.cancelCycle;
  const INVOICE_ID = '22222222-2222-2222-2222-222222222222';

  // The suite runs on fake timers; the dialog flow awaits real ones.
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('makes the payment action primary and Cancel cycle danger, hidden from the header on a phone', () => {
    renderActions('awaiting_payment');
    expect(screen.getByRole('button', { name: 'Mark paid offline' })).toHaveClass('aura-btn--primary');
    const cancel = screen.getByRole('button', { name: 'Cancel cycle' });
    expect(cancel).toHaveClass('aura-btn--danger-secondary');
    expect(cancel).toHaveClass('max-sm:hidden');
  });

  it('styles "Record payment on {bill}" as the primary AURA button', () => {
    renderActions('awaiting_payment', { invoiceId: INVOICE_ID, billNumber: 'SC-2026-000130' });
    expect(screen.getByRole('link', { name: 'Record payment on SC-2026-000130' })).toHaveClass(
      'aura-btn',
      'aura-btn--primary',
    );
  });

  it('renders only Cancel cycle, full width, in the phone danger zone', () => {
    renderActions('awaiting_payment', { invoiceId: INVOICE_ID, billNumber: 'SC-2026-000130' }, 'dangerZone');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark paid offline' })).toBeNull();
    const cancel = screen.getByRole('button', { name: 'Cancel cycle' });
    expect(cancel).toHaveClass('aura-btn--danger-secondary', 'w-full');
    expect(cancel).not.toHaveClass('max-sm:hidden');
  });

  it('renders no danger zone for a cycle that cannot be cancelled', () => {
    const { container } = renderActions('completed', null, 'dangerZone');
    expect(container).toBeEmptyDOMElement();
  });

  it('confirms in an AURA alertdialog and posts the trimmed reason to the same route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    renderActions('reminded');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel cycle' }));
    const dialog = await screen.findByRole('alertdialog', { name: C.dialogTitle });
    expect(dialog).toHaveClass('aura-dialog');
    const confirm = within(dialog).getByRole('button', { name: C.confirm });
    expect(confirm).toHaveClass('aura-btn--danger');
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: new RegExp(`^${C.reasonLabel}`) }), {
      target: { value: '  Member closed the company  ' },
    });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/admin/renewals/${CYCLE_ID}/cancel`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'Member closed the company' });
  });
});
