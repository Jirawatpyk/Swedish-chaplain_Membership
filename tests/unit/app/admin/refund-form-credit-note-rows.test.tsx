/**
 * Spec 122 US8b follow-up — boards `Admin-refund-full` / `Admin-refund-partial`:
 * the refund summary's "Credit note to be issued" rows (amount excl. VAT,
 * VAT {rate}%).
 *
 * The figures come from GET /api/refunds/credit-note-preview — the server's
 * proportional credit-note VAT policy — and the form prints them verbatim.
 * A waived (§105 receipt / voided invoice) or blocked document draws no VAT
 * rows. The refund POST is unchanged byte for byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { RefundForm } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/refund-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

type PreviewBody =
  | { kind: 'issue'; netSatang: string; vatSatang: string; vatRate: string }
  | { kind: 'waived'; reason: string }
  | { kind: 'blocked' };

const fetchMock = vi.fn();

function respondPreview(creditNote: PreviewBody) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.startsWith('/api/refunds/credit-note-preview') && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ creditNote, correlationId: 'c' }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        refund: { status: 'succeeded', creditNoteNumber: 'CN-2026-000013', creditNote: { kind: 'issued', id: 'cn', number: 'CN-2026-000013' } },
      }),
      { status: 201 },
    );
  });
}

beforeEach(() => {
  vi.useRealTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RefundForm
        paymentId="pay_1"
        invoiceId="inv_1"
        memberCompanyName="Acme AB"
        remainingRefundableSatang={3_852_000n}
        currencyCode="THB"
        invoiceSubject="event"
        invoiceHeadroomSatang={3_852_000n}
        onClose={() => undefined}
      />
    </NextIntlClientProvider>,
  );
}

function previewCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/refunds/credit-note-preview'));
}

describe('RefundForm — credit note to be issued', () => {
  it('shows the server split under "Credit note to be issued", above the refund total', async () => {
    respondPreview({ kind: 'issue', netSatang: '500000', vatSatang: '35000', vatRate: '0.0700' });
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });

    const section = await screen.findByTestId('refund-summary-credit-note');
    expect(within(section).getByText('Credit note to be issued')).toBeInTheDocument();
    expect(within(section).getByText('Amount excl. VAT').nextElementSibling).toHaveTextContent('5,000.00 THB');
    expect(within(section).getByText('VAT 7%').nextElementSibling).toHaveTextContent('350.00 THB');

    // Inside the summary, and before "Refund total".
    const summary = screen.getByTestId('refund-summary');
    expect(summary).toContainElement(section);
    const total = within(summary).getByText('Refund total');
    expect(section.compareDocumentPosition(total) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(previewCalls().at(-1)?.[0]).toBe('/api/refunds/credit-note-preview?invoiceId=inv_1&amountSatang=535000');
  });

  it('prints the server figures verbatim — the browser does no VAT arithmetic', async () => {
    // Deliberately NOT what 7/107 of 5,350.00 would give.
    respondPreview({ kind: 'issue', netSatang: '1', vatSatang: '534999', vatRate: '0.0700' });
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    const section = await screen.findByTestId('refund-summary-credit-note');
    expect(within(section).getByText('Amount excl. VAT').nextElementSibling).toHaveTextContent('0.01 THB');
    expect(within(section).getByText('VAT 7%').nextElementSibling).toHaveTextContent('5,349.99 THB');
  });

  it.each([
    ['a §105 receipt (waived)', { kind: 'waived', reason: 'section_105_receipt' } as const],
    ['a voided invoice (waived)', { kind: 'waived', reason: 'invoice_voided' } as const],
    ['a blocked gate', { kind: 'blocked' } as const],
  ])('%s draws no VAT rows, and the summary stays', async (_label, creditNote) => {
    respondPreview(creditNote);
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    // Let the response settle before asserting the absence.
    await waitFor(() => expect(screen.queryByTestId('refund-summary-credit-note-loading')).toBeNull());
    expect(screen.queryByTestId('refund-summary-credit-note')).toBeNull();
    expect(screen.queryByText(/VAT 7%/)).toBeNull();
    expect(within(screen.getByTestId('refund-summary')).getByText('Refund total')).toBeInTheDocument();
  });

  it.each([
    [
      'section_105_receipt',
      'No credit note — this payment has a Section 105 receipt, not a tax invoice.',
    ],
    ['invoice_voided', 'No credit note — this invoice has been voided.'],
  ] as const)('a waived document (%s) says before Confirm that no credit note will be issued', async (reason, text) => {
    respondPreview({ kind: 'waived', reason });
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    const note = await screen.findByTestId('refund-summary-no-credit-note');
    expect(note).toHaveTextContent(text);
    // Inside the summary, before the refund total; a note, not an alert.
    const summary = screen.getByTestId('refund-summary');
    expect(summary).toContainElement(note);
    expect(note.compareDocumentPosition(within(summary).getByText('Refund total')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note).not.toHaveAttribute('role', 'alert');
    // It stays for every later amount — the verdict belongs to the document.
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '100' } });
    expect(screen.getByTestId('refund-summary-no-credit-note')).toHaveTextContent(text);
  });

  it('a blocked gate draws no note — the refund itself is refused with its own message', async () => {
    respondPreview({ kind: 'blocked' });
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('refund-summary-credit-note-loading')).toBeNull());
    expect(screen.queryByTestId('refund-summary-no-credit-note')).toBeNull();
  });

  it('a zero-rated invoice shows VAT 0%, from the stored rate', async () => {
    respondPreview({ kind: 'issue', netSatang: '535000', vatSatang: '0', vatRate: '0.0000' });
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    const section = await screen.findByTestId('refund-summary-credit-note');
    expect(within(section).getByText('VAT 0%').nextElementSibling).toHaveTextContent('0.00 THB');
  });

  it('a waived document is asked once: changing the amount sends no new read', async () => {
    respondPreview({ kind: 'waived', reason: 'section_105_receipt' });
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('refund-summary-credit-note-loading')).toBeNull());
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '100' } });
    await new Promise((r) => setTimeout(r, 400));
    expect(previewCalls()).toHaveLength(1);
    expect(screen.queryByTestId('refund-summary-credit-note-loading')).toBeNull();
  });

  it('while loading, the section keeps its labels and only the values wait', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    const loading = screen.getByTestId('refund-summary-credit-note-loading');
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(loading).toHaveAccessibleName('Credit note to be issued');
    expect(within(loading).getByText('Credit note to be issued')).toBeInTheDocument();
    expect(within(loading).getByText('Amount excl. VAT')).toBeInTheDocument();
    expect(within(loading).getByText('VAT')).toBeInTheDocument();
  });

  it('no preview request while the amount is invalid', async () => {
    respondPreview({ kind: 'issue', netSatang: '500000', vatSatang: '35000', vatRate: '0.0700' });
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '99999999' } });
    await new Promise((r) => setTimeout(r, 400));
    expect(previewCalls()).toHaveLength(0);
    expect(screen.queryByTestId('refund-summary-credit-note')).toBeNull();
  });

  it('a failed preview hides the rows and never blocks the refund', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    fireEvent.change(screen.getByTestId('refund-form-reason'), { target: { value: 'Duplicate charge' } });
    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('refund-form-confirm')).toBeEnabled());
    expect(screen.queryByTestId('refund-summary-credit-note')).toBeNull();
  });

  it('the help line is still the first element whose id ends in "-help" (e2e helper)', async () => {
    respondPreview({ kind: 'issue', netSatang: '500000', vatSatang: '35000', vatRate: '0.0700' });
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    await screen.findByTestId('refund-summary-credit-note');
    expect(document.querySelector('[id$="-help"]')).toHaveTextContent(/^Up to 38,520\.00 THB/);
  });

  it('the refund POST is unchanged byte for byte', async () => {
    respondPreview({ kind: 'issue', netSatang: '500000', vatSatang: '35000', vatRate: '0.0700' });
    renderForm();
    fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value: '5350' } });
    fireEvent.change(screen.getByTestId('refund-form-reason'), { target: { value: 'Duplicate charge' } });
    await screen.findByTestId('refund-summary-credit-note');
    await waitFor(() => expect(screen.getByTestId('refund-form-confirm')).toBeEnabled());
    fireEvent.click(screen.getByTestId('refund-form-confirm'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/refunds/initiate')).toBe(true),
    );
    const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/refunds/initiate')!;
    expect(init).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"paymentId":"pay_1","amountSatang":535000,"reason":"Duplicate charge"}',
    });
  });
});
