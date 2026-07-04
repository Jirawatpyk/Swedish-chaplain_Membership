/**
 * 064 follow-up (Task 14 product gap) — <InvoiceMoreMenu> item-visibility +
 * label matrix.
 *
 * Product gap being fixed: an as-paid TIN event invoice persists its MAIN
 * pdf as the final combined §86/4+§105ทวิ document (`pdfDocKind ===
 * 'receipt_combined'`, receipt_* blob columns NULL). The detail page's
 * pre-064 heuristic (`paid && receiptDocumentNumberRaw === null` → hide the
 * main download as a "stale pre-payment draft") wrongly suppressed the ONLY
 * downloadable document on such rows. The fix threads a `mainDownloadKind`
 * prop into this menu (064-remediation A4 generalised the original
 * `mainDownloadIsCombined` boolean) so the main Download item stays visible
 * AND carries the combined dual-role label for as-paid TIN rows, or the
 * receipt label for β no-TIN rows (`actions.downloadCombined` /
 * `actions.downloadReceipt`, reused — no new i18n keys).
 *
 * Base UI Menu renders its Popup only while open (portal + positioner +
 * pointer interactions jsdom does not model), so the `@/components/ui/
 * dropdown-menu` primitives are mocked to inline plain-HTML stand-ins —
 * the behaviour under test is THIS component's visibility/label matrix,
 * not Base UI's open/close mechanics. Same pattern as
 * member-invoices-group.test.tsx (cmdk/Dialog stand-ins).
 *
 * next-intl is mocked to echo keys so label assertions read the exact key.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock('next-intl', () => ({
  useTranslations:
    () =>
    (key: string, vals?: Record<string, unknown>) =>
      vals ? `${key} ${JSON.stringify(vals)}` : key,
}));

// The fetch+blob download helpers reach the network — stub them out; the
// menu test never exercises a download, only item visibility + labels.
vi.mock(
  '@/app/(staff)/admin/invoices/_lib/download-receipt-client',
  () => ({
    downloadInvoice: vi.fn(),
    downloadReceipt: vi.fn(),
  }),
);

vi.mock('@/components/ui/dropdown-menu', () => {
  function DropdownMenu({ children }: { children?: React.ReactNode }) {
    return <div data-testid="menu-root">{children}</div>;
  }
  function DropdownMenuTrigger({
    render: renderProp,
  }: {
    render?: (props: Record<string, unknown>) => React.ReactNode;
  }) {
    return <>{renderProp ? renderProp({}) : null}</>;
  }
  function DropdownMenuContent({
    children,
  }: {
    children?: React.ReactNode;
    align?: string;
    className?: string;
  }) {
    return <div role="menu">{children}</div>;
  }
  function DropdownMenuItem({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    'data-testid'?: string;
    'aria-label'?: string;
  }) {
    return (
      <button
        type="button"
        role="menuitem"
        onClick={onClick}
        disabled={disabled}
        {...rest}
      >
        {children}
      </button>
    );
  }
  return {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
  };
});

const { InvoiceMoreMenu } = await import(
  '@/app/(staff)/admin/invoices/_components/invoice-more-menu'
);

const BASE = {
  invoiceId: 'inv-1',
  documentNumber: 'INV-2026-000001',
  showDownload: false,
  showResendInvoice: false,
  showResendReceipt: false,
} as const;

/** Icon svgs carry no text — an item's textContent IS its echoed label key. */
function labelOf(testId: string): string | null {
  return screen.getByTestId(testId).textContent;
}

describe('InvoiceMoreMenu — as-paid combined main download (064 gap fix)', () => {
  it("shows the main Download item with the COMBINED dual-role label when mainDownloadKind='combined'", () => {
    render(
      <InvoiceMoreMenu
        {...BASE}
        showDownload
        mainDownloadKind="combined"
      />,
    );
    expect(labelOf('download-invoice-trigger')).toBe(
      'actions.downloadCombined',
    );
    // The combined doc is the ONLY document on an as-paid TIN row — no
    // separate receipt item may appear.
    expect(screen.queryByTestId('download-receipt-trigger')).toBeNull();
  });

  it('keeps the plain invoice label when mainDownloadKind is omitted (bill-first/membership rows byte-identical)', () => {
    render(<InvoiceMoreMenu {...BASE} showDownload />);
    expect(labelOf('download-invoice-trigger')).toBe('actions.download');
  });
});

describe("InvoiceMoreMenu — β receipt main download (064 remediation A4, mainDownloadKind='receipt')", () => {
  it('shows the main Download item with the RECEIPT label + receipt aria (the β main pdf IS the §105 receipt)', () => {
    render(
      <InvoiceMoreMenu
        {...BASE}
        documentNumber="RC-2026-000777"
        showDownload
        mainDownloadKind="receipt"
      />,
    );
    const item = screen.getByTestId('download-invoice-trigger');
    expect(item.textContent).toBe('actions.downloadReceipt');
    // The aria flips to the receipt wording with the printed §105 number —
    // never the invoice wording (the file the admin grabs is a receipt).
    expect(item).toHaveAttribute(
      'aria-label',
      'actions.downloadReceiptAria {"number":"RC-2026-000777"}',
    );
    // β rows have NO separate receipt blob — no second receipt item.
    expect(screen.queryByTestId('download-receipt-trigger')).toBeNull();
  });
});

describe('InvoiceMoreMenu — 088 paid bill SC-vs-RC naming (T065 review fix)', () => {
  it('names the MAIN (SC bill) download by invoiceDownloadNumber while the receipt arm keeps documentNumber (RC)', () => {
    // On a paid 088 bill `documentNumber` resolves to the RC §86/4 tax-receipt
    // number, but the main download serves the non-tax SC bill — so the two
    // download affordances must carry DISTINCT numbers (SC vs RC).
    render(
      <InvoiceMoreMenu
        {...BASE}
        documentNumber="RC-2026-000123"
        invoiceDownloadNumber="SC-2026-000045"
        showDownload
        showDownloadReceipt
      />,
    );
    expect(screen.getByTestId('download-invoice-trigger')).toHaveAttribute(
      'aria-label',
      'actions.downloadInvoiceAria {"number":"SC-2026-000045"}',
    );
    expect(screen.getByTestId('download-receipt-trigger')).toHaveAttribute(
      'aria-label',
      'actions.downloadReceiptAria {"number":"RC-2026-000123"}',
    );
  });

  it('falls back to documentNumber for the main download when invoiceDownloadNumber is omitted (pre-088 byte-identical)', () => {
    render(<InvoiceMoreMenu {...BASE} showDownload />);
    expect(screen.getByTestId('download-invoice-trigger')).toHaveAttribute(
      'aria-label',
      'actions.downloadInvoiceAria {"number":"INV-2026-000001"}',
    );
  });
});

describe('InvoiceMoreMenu — pre-064 matrix pinned (regression net)', () => {
  it('bill-first combined-mode paid: receipt item carries the combined label, main download hidden', () => {
    // combinedModeReceipt is derived inside the menu from
    // (showDownloadReceipt && !showDownload).
    render(<InvoiceMoreMenu {...BASE} showDownloadReceipt />);
    expect(screen.queryByTestId('download-invoice-trigger')).toBeNull();
    expect(labelOf('download-receipt-trigger')).toBe(
      'actions.downloadCombined',
    );
  });

  it('separate-mode paid: BOTH downloads with their own plain labels', () => {
    render(<InvoiceMoreMenu {...BASE} showDownload showDownloadReceipt />);
    expect(labelOf('download-invoice-trigger')).toBe('actions.download');
    expect(labelOf('download-receipt-trigger')).toBe(
      'actions.downloadReceipt',
    );
  });

  it('renders nothing at all when no item is visible', () => {
    const { container } = render(<InvoiceMoreMenu {...BASE} />);
    expect(container.firstChild).toBeNull();
  });
});
