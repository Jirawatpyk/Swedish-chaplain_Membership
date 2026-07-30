/**
 * Option A UX redesign — admin-tax (`show088Filters=true`) branch of
 * `<InvoiceFilters>`: the "Filters" popover + the removable secondary-filter
 * chips.
 *
 * Its sibling `tests/unit/app/portal/invoices/invoice-filters-props.test.tsx`
 * pins the NON-collapsed layout (portal / flag-off admin — Subject + Paid-online
 * inline, no popover, no chips). This file pins the collapsed admin-tax layout:
 *   (a) the secondary Selects are NOT loose in the inline bar — they appear
 *       only after the "Filters" popover is opened;
 *   (b) the trigger badge counts the active secondary filters;
 *   (c) each active secondary filter surfaces a removable chip whose ✕ clears
 *       just that param (asserted via the router push URL).
 *
 * Harness (mirrors the sibling): real `NextIntlClientProvider` + real `en.json`
 * (assert the SHIPPED copy), stub `next/navigation`.
 *
 * `@/components/ui/select` is mocked to eager stubs — Base UI Select's options
 * live in a pointer-driven Portal jsdom cannot open — but, unlike the sibling,
 * this stub FORWARDS `aria-label` + `data-testid` so the secondary selects are
 * addressable by their testids inside the popover.
 *
 * `@/components/ui/popover` is mocked to a STATEFUL stand-in that gates its
 * content on an open flag (the trigger's injected `onClick` toggles it) — the
 * same "Base UI portal/pointer positioning jsdom can't drive" reason
 * `auto-renewal-queue-actions.test.tsx` mocks `@/components/ui/dropdown-menu`.
 * The ref-forwarding concern is NOT mocked away: no custom `ref` is used here
 * (the component spreads the Trigger's own props into `<Button>` and adds none
 * of its own), so the stand-in calls `render({ onClick })` with no ref.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

// The client component reads URL state + pushes via the app router. Stub the
// navigation hooks the Next app shell would provide (no real router in jsdom).
const replace = vi.fn();
// Mutable so a test can seed the URL the component reads (e.g. `?docType=sc`).
// Reset to empty in beforeEach so each test starts from a clean URL.
let searchParamsStub = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  useSearchParams: () => searchParamsStub,
  usePathname: () => '/admin/invoices',
}));

// Eager, testid-preserving Select stubs (Base UI Select's popup is
// pointer-driven; jsdom can't open it). Forwards `aria-label` + `data-testid`
// so the secondary selects can be located by testid inside the popover.
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <div role="option" aria-selected={false} data-value={value}>
      {children}
    </div>
  ),
  SelectTrigger: ({
    children,
    'aria-label': ariaLabel,
    'data-testid': testid,
  }: {
    children: ReactNode;
    'aria-label'?: string;
    'data-testid'?: string;
  }) => (
    <div aria-label={ariaLabel} data-testid={testid}>
      {children}
    </div>
  ),
  TranslatedSelectValue: () => null,
}));

// Stateful Popover stand-in: content renders only while `open`; the Trigger's
// injected `onClick` toggles it. This keeps "the secondary Selects appear AFTER
// opening" a real behavioural assertion rather than a DOM-order proxy.
vi.mock('@/components/ui/popover', async () => {
  const { createContext, useContext, useState } = await import('react');
  const OpenCtx = createContext<{ open: boolean; toggle: () => void }>({
    open: false,
    toggle: () => {},
  });
  return {
    Popover: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = useState(false);
      return (
        <OpenCtx.Provider value={{ open, toggle: () => setOpen((o) => !o) }}>
          <div>{children}</div>
        </OpenCtx.Provider>
      );
    },
    PopoverTrigger: ({
      render: renderProp,
    }: {
      render: (props: Record<string, unknown>) => ReactNode;
    }) => {
      const { toggle } = useContext(OpenCtx);
      // React-19 shape: pass props (incl. the click handler) the component
      // spreads onto its <Button>. No ref — none is used by the component.
      return <>{renderProp({ onClick: toggle })}</>;
    },
    PopoverContent: ({ children }: { children: ReactNode }) => {
      const { open } = useContext(OpenCtx);
      return open ? (
        <div data-testid="filters-popover-content">{children}</div>
      ) : null;
    },
    PopoverTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  };
});

import { InvoiceFilters } from '@/app/(staff)/admin/invoices/_components/invoice-filters';

const f = enMessages.admin.invoices.list.filters;

function renderAdminTax() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <InvoiceFilters show088Filters showPaidOnlineChip />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  replace.mockClear();
  searchParamsStub = new URLSearchParams();
});

describe('<InvoiceFilters> — admin-tax secondary filters live in the popover', () => {
  it('does not render the secondary Selects until the "Filters" popover is opened', () => {
    renderAdminTax();

    // Not loose in the inline bar — the popover starts closed, so its content
    // (and every secondary Select + the Paid-online toggle) is unmounted.
    expect(screen.queryByTestId('invoice-subject-filter')).toBeNull();
    expect(screen.queryByTestId('invoice-document-type-filter')).toBeNull();
    expect(screen.queryByTestId('invoice-tax-point-filter')).toBeNull();
    expect(screen.queryByTestId('invoice-vat-treatment-filter')).toBeNull();
    expect(screen.queryByTestId('paid-online-filter-chip')).toBeNull();

    // Open the popover.
    fireEvent.click(screen.getByTestId('invoice-more-filters-trigger'));

    const content = screen.getByTestId('filters-popover-content');
    expect(
      within(content).getByTestId('invoice-subject-filter'),
    ).toBeInTheDocument();
    expect(
      within(content).getByTestId('invoice-document-type-filter'),
    ).toBeInTheDocument();
    expect(
      within(content).getByTestId('invoice-tax-point-filter'),
    ).toBeInTheDocument();
    expect(
      within(content).getByTestId('invoice-vat-treatment-filter'),
    ).toBeInTheDocument();
    // The Paid-online reconciliation toggle moved into the popover too.
    expect(
      within(content).getByTestId('paid-online-filter-chip'),
    ).toBeInTheDocument();
  });
});

describe('<InvoiceFilters> — the "Filters" trigger badge counts active secondaries', () => {
  it('shows no badge when no secondary filter is active', () => {
    renderAdminTax();
    expect(screen.queryByTestId('invoice-more-filters-count')).toBeNull();
  });

  it('counts Subject + Document type + VAT as 3', () => {
    searchParamsStub = new URLSearchParams(
      'subject=membership&docType=sc&vat=standard',
    );
    renderAdminTax();
    // Badge lives in the trigger — visible without opening the popover.
    expect(screen.getByTestId('invoice-more-filters-count')).toHaveTextContent(
      '3',
    );
  });
});

describe('<InvoiceFilters> — active secondary filters surface as removable chips', () => {
  it('renders a chip carrying the translated value label of the active filter', () => {
    searchParamsStub = new URLSearchParams('docType=sc');
    renderAdminTax();
    // The chip text is the SAME translated value label the Select would show.
    expect(screen.getByText(f.documentType.sc)).toBeInTheDocument();
  });

  it("the chip's ✕ clears just its own param (status survives) via the router", () => {
    searchParamsStub = new URLSearchParams('docType=sc&status=paid');
    renderAdminTax();

    const removeBtn = screen.getByRole('button', {
      name: `Remove filter: ${f.documentType.sc}`,
    });
    fireEvent.click(removeBtn);

    expect(replace).toHaveBeenCalledTimes(1);
    const url = String(replace.mock.calls[0]?.[0]);
    // docType dropped …
    expect(url).not.toContain('docType');
    // … while the unrelated status filter survives.
    expect(url).toContain('status=paid');
  });

  it('renders no chips row when no secondary filter is active', () => {
    renderAdminTax();
    // The only ✕-labelled controls are chip removers; none exist here.
    expect(
      screen.queryByRole('button', { name: /^Remove filter:/ }),
    ).toBeNull();
  });
});

// renewals-suspended-visibility-audit Task 3 — the URL-only `?dueBefore=`
// filter (no Select control; arrives via drill-down links, e.g. the renewals
// money band's prior-FY sub-line).
describe('<InvoiceFilters> — dueBefore chip (Task 3)', () => {
  function renderWithDueBefore(props: {
    show088Filters?: boolean;
    showDueBeforeFilter?: boolean;
  }) {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <InvoiceFilters
          show088Filters={props.show088Filters ?? true}
          showPaidOnlineChip
          showDueBeforeFilter={props.showDueBeforeFilter ?? true}
        />
      </NextIntlClientProvider>,
    );
  }

  it('a valid ?dueBefore surfaces a localized chip whose ✕ clears just that param', () => {
    searchParamsStub = new URLSearchParams('dueBefore=2026-01-01&status=overdue');
    renderWithDueBefore({});
    const chipLabel = screen.getByText('Due before 2026-01-01');
    expect(chipLabel).toBeInTheDocument();
    // A4 — the date IS the chip's payload: the default 24ch label bound
    // truncates it under the longer SV/TH prefixes, so this chip (and only
    // this chip) widens to 28ch (tailwind-merge lets the override win).
    expect(chipLabel.className).toContain('max-w-[28ch]');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove filter: Due before 2026-01-01',
      }),
    );
    expect(replace).toHaveBeenCalledTimes(1);
    const url = String(replace.mock.calls[0]?.[0]);
    expect(url).not.toContain('dueBefore');
    // The drill-down's status filter survives the chip removal.
    expect(url).toContain('status=overdue');
  });

  it('malformed values are ignored — no chip, no phantom active filter (2026-02-30 is not a calendar date)', () => {
    searchParamsStub = new URLSearchParams('dueBefore=2026-02-30');
    renderWithDueBefore({});
    expect(screen.queryByText(/^Due before/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /^Remove filter:/ }),
    ).toBeNull();

    searchParamsStub = new URLSearchParams('dueBefore=garbage');
    renderWithDueBefore({});
    expect(screen.queryByText(/^Due before/)).toBeNull();
  });

  it('gated off by default (portal shape): a stray ?dueBefore renders nothing', () => {
    searchParamsStub = new URLSearchParams('dueBefore=2026-01-01');
    renderWithDueBefore({ showDueBeforeFilter: false });
    expect(screen.queryByText(/^Due before/)).toBeNull();
  });

  it('renders the chip in the INLINE layout too (flag-off admin following a drill-down link)', () => {
    searchParamsStub = new URLSearchParams('dueBefore=2026-01-01');
    renderWithDueBefore({ show088Filters: false });
    // No popover in this layout — the chip is the filter's only visible
    // representation, rendered in a standalone chips row below the bar.
    expect(screen.getByText('Due before 2026-01-01')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Remove filter: Due before 2026-01-01',
      }),
    ).toBeInTheDocument();
  });
});
