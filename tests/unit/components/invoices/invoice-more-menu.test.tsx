/**
 * 064 follow-up (Task 14 product gap) — <InvoiceMoreMenu> item-visibility +
 * label matrix.
 *
 * Product gap being fixed: an as-paid TIN event invoice persists its MAIN
 * pdf as the final combined §86/4+§105ทวิ document (`pdfDocKind ===
 * 'receipt_combined'`, receipt_* blob columns NULL). The detail page's
 * pre-064 heuristic (`paid && receiptDocumentNumberRaw === null` → hide the
 * main download as a "stale pre-payment draft") wrongly suppressed the ONLY
 * downloadable document on such rows. The fix threads a new
 * `mainDownloadIsCombined` prop into this menu so the main Download item
 * stays visible AND carries the combined dual-role label
 * (`actions.downloadCombined`, reused — no new i18n keys).
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
  it('shows the main Download item with the COMBINED dual-role label when mainDownloadIsCombined', () => {
    render(
      <InvoiceMoreMenu
        {...BASE}
        showDownload
        mainDownloadIsCombined
      />,
    );
    expect(labelOf('download-invoice-trigger')).toBe(
      'actions.downloadCombined',
    );
    // The combined doc is the ONLY document on an as-paid TIN row — no
    // separate receipt item may appear.
    expect(screen.queryByTestId('download-receipt-trigger')).toBeNull();
  });

  it('keeps the plain invoice label when mainDownloadIsCombined is omitted (bill-first/membership rows byte-identical)', () => {
    render(<InvoiceMoreMenu {...BASE} showDownload />);
    expect(labelOf('download-invoice-trigger')).toBe('actions.download');
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
