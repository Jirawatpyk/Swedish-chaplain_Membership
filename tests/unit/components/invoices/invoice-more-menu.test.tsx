/**
 * The invoice detail page's ⋯ menu on AURA's `DropdownMenu` (spec 122 US8b
 * T824), opened as a user opens it.
 *
 * - Item visibility and labels (064 A4): the main download reads as the
 *   combined document on an as-paid TIN row, as a receipt on a β row, as a
 *   bill on an 088 SC- bill, else as the invoice.
 * - Every document control names its own document (FR-015, 088 T065): the
 *   bill actions carry the SC number, the receipt actions the RC, shown as
 *   the item's hint and so part of its name. The trigger names the bill.
 * - The download filenames and the resend request are unchanged.
 * - Below 640px the menu also holds Void… (the phone action bar, spec
 *   Session 2026-10-02 US8b), last, after a separator.
 * - Nothing visible → nothing rendered.
 *
 * next-intl echoes keys so label assertions read the exact key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(() => 'l'), dismiss: vi.fn() },
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) => (vals ? `${key} ${JSON.stringify(vals)}` : key),
}));
const download = vi.hoisted(() => ({ downloadInvoice: vi.fn(), downloadReceipt: vi.fn() }));
vi.mock('@/app/(staff)/admin/invoices/_lib/download-receipt-client', () => download);

const { InvoiceMoreMenu } = await import('@/app/(staff)/admin/invoices/_components/invoice-more-menu');

const BASE = {
  invoiceId: 'inv-1',
  documentNumber: 'INV-2026-000001',
  showDownload: false,
  showResendInvoice: false,
  showResendReceipt: false,
} as const;

function setPhone(phone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: phone && query.includes('max-width'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as never;
}

beforeEach(() => setPhone(false));
afterEach(() => vi.clearAllMocks());

function open(number = 'INV-2026-000001') {
  fireEvent.click(screen.getByRole('button', { name: `actions.moreAria {"number":"${number}"}` }));
  return screen.getByRole('menu');
}
/** Settle the click's promises (the suite runs on fake timers, so no `waitFor`). */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}
const names = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((i) => i.textContent);

describe('InvoiceMoreMenu — the main download\'s label (064 A4, 088)', () => {
  it('reads as the combined document on an as-paid TIN row, with no separate receipt item', () => {
    render(<InvoiceMoreMenu {...BASE} showDownload mainDownloadKind="combined" />);
    expect(names(open())).toEqual(['actions.downloadCombinedINV-2026-000001']);
  });

  it('reads as the invoice when no kind is given', () => {
    render(<InvoiceMoreMenu {...BASE} showDownload />);
    expect(names(open())).toEqual(['actions.downloadINV-2026-000001']);
  });

  it('reads as a receipt on a β row, named by its §105 number', () => {
    render(<InvoiceMoreMenu {...BASE} documentNumber="RC-2026-000777" showDownload mainDownloadKind="receipt" />);
    expect(names(open('RC-2026-000777'))).toEqual(['actions.downloadReceiptRC-2026-000777']);
  });

  it('reads as a bill on an 088 SC- bill, never a tax invoice', () => {
    render(<InvoiceMoreMenu {...BASE} documentNumber="SC-2026-000045" showDownload mainDownloadKind="bill" />);
    expect(names(open('SC-2026-000045'))).toEqual(['actions.downloadBillSC-2026-000045']);
  });
});

describe('InvoiceMoreMenu — a paid 088 bill: bill actions name the SC, receipt actions the RC', () => {
  function renderPaid088() {
    render(
      <InvoiceMoreMenu
        {...BASE}
        documentNumber="RC-2026-000123"
        invoiceDownloadNumber="SC-2026-000045"
        showDownload
        showDownloadReceipt
        showResendInvoice
        showResendReceipt
      />,
    );
  }

  it('the trigger names the bill, and each item its own document', () => {
    renderPaid088();
    expect(names(open('SC-2026-000045'))).toEqual([
      'actions.downloadSC-2026-000045',
      'actions.downloadReceiptRC-2026-000123',
      'actions.resendInvoiceSC-2026-000045',
      'actions.resendReceiptRC-2026-000123',
    ]);
  });

  it('downloads keep their filenames: the bill by its SC, the receipt by its RC', async () => {
    renderPaid088();
    fireEvent.click(within(open('SC-2026-000045')).getByRole('menuitem', { name: /^actions\.download\s*SC/ }));
    await settle();
    expect(download.downloadInvoice).toHaveBeenCalledTimes(1);
    expect(download.downloadInvoice.mock.calls[0]![0]).toMatchObject({ invoiceId: 'inv-1', fallbackFilename: 'SC-2026-000045.pdf' });
    fireEvent.click(within(open('SC-2026-000045')).getByRole('menuitem', { name: /^actions\.downloadReceipt\s*RC/ }));
    await settle();
    expect(download.downloadReceipt).toHaveBeenCalledTimes(1);
    expect(download.downloadReceipt.mock.calls[0]![0]).toMatchObject({ invoiceId: 'inv-1', fallbackFilename: 'RC-2026-000123-receipt.pdf' });
  });

  it('a resend posts { variant } to the invoice\'s resend route, unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ recipientEmail: 'a@b.example' }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    renderPaid088();
    fireEvent.click(within(open('SC-2026-000045')).getByRole('menuitem', { name: /^actions\.resendReceipt\s*RC/ }));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/invoices/inv-1/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant: 'receipt' }),
    });
    vi.unstubAllGlobals();
  });
});

describe('InvoiceMoreMenu — Void… on a phone (the action bar)', () => {
  it('below 640px holds Void… last, after a separator, linking to the void page', () => {
    setPhone(true);
    render(<InvoiceMoreMenu {...BASE} showDownload showVoid />);
    const menu = open();
    const items = within(menu).getAllByRole('menuitem');
    const voidItem = items[items.length - 1]!;
    expect(voidItem).toHaveTextContent('actions.void');
    expect(voidItem).toHaveAttribute('href', '/admin/invoices/inv-1/void');
    expect(menu.querySelector('[role="separator"]')).not.toBeNull();
  });

  it('from 640px leaves Void… to the header\'s own button', () => {
    render(<InvoiceMoreMenu {...BASE} showDownload showVoid />);
    expect(within(open()).queryByRole('menuitem', { name: 'actions.void' })).toBeNull();
  });
});

describe('InvoiceMoreMenu — nothing to show', () => {
  it('renders nothing at all', () => {
    const { container } = render(<InvoiceMoreMenu {...BASE} />);
    expect(container.firstChild).toBeNull();
  });
});
