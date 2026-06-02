/**
 * B7 / FR-026 — EmailFailureAlert component test (Round-2 coverage gap).
 * Pins the variant→POST mapping, the success-toast recipient (must use the
 * route's RETURNED current address, not the stale failed prop), variant-specific
 * copy, and the canResend gating of the hint + button.
 *
 * next-intl is mocked to echo `key {vals}` so assertions can read both the key
 * and the interpolated recipient.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
vi.mock('sonner', () => ({ toast }));
vi.mock('next-intl', () => ({
  useTranslations:
    () =>
    (key: string, vals?: Record<string, unknown>) =>
      vals ? `${key} ${JSON.stringify(vals)}` : key,
}));

const { EmailFailureAlert } = await import(
  '@/app/(staff)/admin/invoices/_components/email-failure-alert'
);

function resp(status: number, body: unknown) {
  return { status, json: async () => body } as unknown as Response;
}

describe('EmailFailureAlert (B7 / FR-026)', () => {
  beforeEach(() => vi.clearAllMocks());
  // Restore the stubbed global fetch so it doesn't leak into other suites.
  afterEach(() => vi.unstubAllGlobals());

  it('posts the RECEIPT variant + toasts the returned (current) recipient, not the stale prop', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      resp(202, { recipientEmail: 'new@y.com' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <EmailFailureAlert
        invoiceId="inv-1"
        recipientEmail="old@x.com"
        variant="receipt"
        canResend
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('/api/invoices/inv-1/resend');
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      variant: 'receipt',
    });

    expect(toast.success).toHaveBeenCalledTimes(1);
    const msg = toast.success.mock.calls[0]![0] as string;
    expect(msg).toContain('new@y.com'); // returned current address
    expect(msg).not.toContain('old@x.com'); // NOT the historical failed one
  });

  it('posts the INVOICE variant for an invoice-copy failure', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      resp(202, { recipientEmail: 'a@b.com' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <EmailFailureAlert
        invoiceId="inv-2"
        recipientEmail="a@b.com"
        variant="invoice"
        canResend
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string),
    ).toEqual({ variant: 'invoice' });
  });

  it('shows the specific no_receipt_pdf warning on a 409, not the generic failure', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      resp(409, { error: { code: 'no_receipt_pdf' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <EmailFailureAlert
        invoiceId="inv-5"
        recipientEmail="x@y.com"
        variant="receipt"
        canResend
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(toast.warning).toHaveBeenCalledWith('toast.resendNoReceipt');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('renders variant-specific copy (receipt title/button), not invoice copy', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(
      <EmailFailureAlert
        invoiceId="inv-3"
        recipientEmail="x@y.com"
        variant="receipt"
        canResend
      />,
    );
    expect(screen.getByText('deliveryFailure.receipt.title')).toBeDefined();
    expect(
      screen.getByText('deliveryFailure.receipt.resend'),
    ).toBeDefined();
  });

  it('hides the resend button AND the edit-recipient hint when canResend is false', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(
      <EmailFailureAlert
        invoiceId="inv-4"
        recipientEmail="x@y.com"
        variant="invoice"
        canResend={false}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('deliveryFailure.editRecipientHint')).toBeNull();
  });
});
