/**
 * F5 UX D2 + CF-2 — AutoRefundFailedAlert component test.
 *
 * Pins the destructive banner an admin sees on the invoice detail page when an
 * automatic stale-invoice refund FAILED at the processor (money not returned),
 * AND the CF-2 "Mark as reconciled" resolve action: a confirmation dialog (per
 * ux-standards — money/audit action) that POSTs to the resolve route + refreshes
 * so the persistent alert clears.
 *
 * Uses a real NextIntlClientProvider + real en.json (canonical) so the copy is
 * exercised end-to-end; mocks fetch / router / sonner. Real timers (global setup
 * fakes them) — mirrors cancel-broadcast-action.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
  fireEvent,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { toast } from 'sonner';
import { AutoRefundFailedAlert } from '@/app/(staff)/admin/invoices/_components/auto-refund-failed-alert';

const copy = en.admin.invoices.detail.autoRefundFailed;
const RESOLVE_URL = '/api/refunds/resolve-auto-refund-failure';

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

function renderAlert(
  props: Partial<React.ComponentProps<typeof AutoRefundFailedAlert>> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <AutoRefundFailedAlert
        invoiceId="inv-1"
        processorRefundId="re_test_ABCD1234"
        runbookUrl="docs/runbooks/out-of-band-refund.md"
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

describe('AutoRefundFailedAlert (F5 UX D2)', () => {
  it('renders a destructive alert with title, body, the FULL processor refund ref, and the runbook path', () => {
    renderAlert();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(copy.title)).toBeInTheDocument();
    const refLine = screen.getByTestId('admin-invoice-auto-refund-failed-ref');
    expect(refLine.textContent).toContain('re_test_ABCD1234');
    expect(screen.getByText(/out-of-band-refund\.md/)).toBeInTheDocument();
  });

  it('omits the reference line when no processor refund id is available', () => {
    renderAlert({ processorRefundId: null });
    expect(
      screen.queryByTestId('admin-invoice-auto-refund-failed-ref'),
    ).toBeNull();
    expect(screen.getByText(copy.title)).toBeInTheDocument();
  });
});

describe('AutoRefundFailedAlert — CF-2 resolve/acknowledge action', () => {
  it('renders a "Mark as reconciled" trigger button', () => {
    renderAlert();
    expect(
      screen.getByRole('button', { name: copy.resolve }),
    ).toBeInTheDocument();
  });

  it('opens a confirmation dialog before doing anything (money/audit action)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderAlert();
    fireEvent.click(screen.getByRole('button', { name: copy.resolve }));
    expect(
      await screen.findByText(copy.resolveConfirm.title),
    ).toBeInTheDocument();
    // Nothing posted merely by opening the dialog.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('on confirm — POSTs the invoiceId to the resolve route, then refreshes + toasts success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ outcome: 'reconciled' }),
    } as Response);

    renderAlert({ invoiceId: 'inv-42' });
    fireEvent.click(screen.getByRole('button', { name: copy.resolve }));
    await screen.findByText(copy.resolveConfirm.title);

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: copy.resolveConfirm.confirm }),
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        RESOLVE_URL,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ invoiceId: 'inv-42' }),
        }),
      );
    });
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith(copy.resolveSuccess);
  });

  it('on a non-2xx response — toasts an error and does NOT refresh', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'no_failed_auto_refund' } }),
    } as Response);

    renderAlert();
    fireEvent.click(screen.getByRole('button', { name: copy.resolve }));
    await screen.findByText(copy.resolveConfirm.title);

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: copy.resolveConfirm.confirm }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
