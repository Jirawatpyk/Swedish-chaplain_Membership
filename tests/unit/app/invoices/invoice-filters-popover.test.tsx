/**
 * Option A UX redesign — admin-tax (`show088Filters=true`) branch of
 * `<InvoiceFilters>`: the "More filters" popover + the removable secondary-filter
 * chips.
 *
 * Its sibling `tests/unit/app/portal/invoices/invoice-filters-props.test.tsx`
 * pins the NON-collapsed layout (portal / flag-off admin — Subject + Paid-online
 * inline, no popover, no chips). This file pins the collapsed admin-tax layout:
 *   (a) the secondary Selects are NOT loose in the inline bar — they appear
 *       only after the "More filters" popover is opened;
 *   (b) the trigger badge counts the active secondary filters;
 *   (c) each active secondary filter surfaces a removable chip whose ✕ clears
 *       just that param (asserted via the router push URL).
 *
 * Harness (mirrors the sibling): real `NextIntlClientProvider` + real `en.json`
 * (assert the SHIPPED copy), stub `next/navigation`.
 *
 * Nothing UI is mocked since spec 122 US4: AURA's Select keeps a native
 * `<select>` behind its combobox, and AURA's Popover opens from the trigger
 * click under jsdom, so the real components are driven directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Spec 122 US4 — the real AURA Select and Popover (no stubs): the popover's
// content mounts only while it is open, so "the secondary Selects appear
// AFTER opening" stays a behavioural assertion.

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
  it('does not render the secondary Selects until the "More filters" popover is opened', () => {
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

describe('<InvoiceFilters> — the "More filters" trigger badge counts active secondaries', () => {
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
  it('renders a chip naming the filter and its translated value', () => {
    searchParamsStub = new URLSearchParams('docType=sc');
    renderAdminTax();
    // The filter's name, then the SAME translated value label the Select shows.
    expect(screen.getByText(`${f.documentType.label}: ${f.documentType.sc}`)).toBeInTheDocument();
  });

  it('the trigger reads "More filters" and is 44px on touch', () => {
    renderAdminTax();
    const trigger = screen.getByTestId('invoice-more-filters-trigger');
    expect(trigger).toHaveTextContent(f.more.button);
    expect(f.more.button).toBe('More filters');
    expect(trigger).toHaveClass('aura-btn--touch');
  });

  it('chips live in the FilterBar, so its own Clear filters clears every param', () => {
    searchParamsStub = new URLSearchParams('docType=sc&status=paid');
    renderAdminTax();
    const chips = document.querySelector('.aura-filterbar__chips');
    expect(chips).toHaveTextContent(`${f.documentType.label}: ${f.documentType.sc}`);
    expect(chips).toHaveTextContent('Status: Paid');
    fireEvent.click(screen.getByRole('button', { name: f.clearAll }));
    expect(String(replace.mock.calls.at(-1)?.[0])).toBe('/admin/invoices');
  });

  it('Paid online is in the popover, so while on it also shows as a chip', () => {
    searchParamsStub = new URLSearchParams('paidOnline=1');
    renderAdminTax();
    const label = enMessages.admin.paymentReconciliation.filterChip.label;
    expect(screen.getByRole('button', { name: `Remove filter: ${label}` })).toBeInTheDocument();
  });

  it("the chip's ✕ clears just its own param (status survives) via the router", () => {
    searchParamsStub = new URLSearchParams('docType=sc&status=paid');
    renderAdminTax();

    const removeBtn = screen.getByRole('button', {
      name: `Remove filter: ${f.documentType.label}: ${f.documentType.sc}`,
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
    showDueDateFilters?: boolean;
  }) {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <InvoiceFilters
          show088Filters={props.show088Filters ?? true}
          showPaidOnlineChip
          showDueDateFilters={props.showDueDateFilters ?? true}
        />
      </NextIntlClientProvider>,
    );
  }

  it('a valid ?dueBefore surfaces a localized chip whose ✕ clears just that param', () => {
    searchParamsStub = new URLSearchParams('dueBefore=2026-01-01&status=overdue');
    renderWithDueBefore({});
    // A4 — the date IS the chip's payload: no local truncation on top of
    // AURA's 24ch chip, which the label fits in every locale.
    const chipLabel = screen.getByText('Due before 2026-01-01');
    expect(chipLabel.closest('.aura-filterbar__chips')).not.toBeNull();
    expect(chipLabel.className).not.toContain('truncate');

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

  it('A1 (#292 review) — the popover shows a READ-ONLY dueBefore row whose clear button reuses the chip handler', () => {
    searchParamsStub = new URLSearchParams('dueBefore=2026-01-01&status=overdue');
    renderWithDueBefore({});
    // The badge counts dueBefore…
    expect(screen.getByTestId('invoice-more-filters-count')).toHaveTextContent('1');
    // …and opening the popover now surfaces it instead of a dead end.
    fireEvent.click(screen.getByTestId('invoice-more-filters-trigger'));
    const content = screen.getByTestId('filters-popover-content');
    expect(
      within(content).getByTestId('invoice-due-before-readout'),
    ).toHaveTextContent('2026-01-01');
    // WCAG 2.5.3 — the row's button reads "Clear", so its name starts with it.
    fireEvent.click(
      within(content).getByRole('button', {
        name: 'Clear Due before 2026-01-01',
      }),
    );
    expect(replace).toHaveBeenCalledTimes(1);
    const url = String(replace.mock.calls[0]?.[0]);
    expect(url).not.toContain('dueBefore');
    expect(url).toContain('status=overdue');
  });

  it('gated off by default (portal shape): a stray ?dueBefore renders nothing', () => {
    searchParamsStub = new URLSearchParams('dueBefore=2026-01-01');
    renderWithDueBefore({ showDueDateFilters: false });
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

// Spec 122 (2026-10-15, AURA #146; maintainer: "lay them out flat in the
// sheet"): below 640px the secondary filters are the bar's own children, so
// AURA's Filters sheet lists them; the popover is for wider screens.
describe('<InvoiceFilters> — admin-tax secondary filters on phones', () => {
  const width = window.innerWidth;
  beforeEach(() => {
    window.innerWidth = 390;
  });
  afterEach(() => {
    window.innerWidth = width;
  });

  it('renders the secondary filters as children of the bar, with no "More filters" popover', () => {
    renderAdminTax();
    expect(screen.queryByTestId('invoice-more-filters-trigger')).toBeNull();
    for (const id of [
      'invoice-subject-filter',
      'invoice-document-type-filter',
      'invoice-tax-point-filter',
      'invoice-vat-treatment-filter',
      'paid-online-filter-chip',
    ]) {
      expect(screen.getByTestId(id).closest('.aura-filterbar__controls')).not.toBeNull();
    }
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute('aria-haspopup', 'dialog');
  });
});

// 124 slice 1 — `?dueAfter=` (inclusive lower bound) and `?plan=` are URL-only
// filters like dueBefore: they arrive from the invoice dashboard's drill-down
// links, show as chips, and clear one param each.
describe('<InvoiceFilters> — dueAfter and plan chips (124)', () => {
  function renderWith(props: {
    show088Filters?: boolean;
    showDueDateFilters?: boolean;
    planFilter?: { id: string; label: string };
  }) {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <InvoiceFilters
          show088Filters={props.show088Filters ?? true}
          showPaidOnlineChip
          showDueDateFilters={props.showDueDateFilters ?? true}
          {...(props.planFilter ? { planFilter: props.planFilter } : {})}
        />
      </NextIntlClientProvider>,
    );
  }

  it('a valid ?dueAfter surfaces a chip whose ✕ clears just that param', () => {
    searchParamsStub = new URLSearchParams('dueAfter=2026-01-01&dueBefore=2026-02-01&status=overdue');
    renderWith({});
    expect(screen.getByText('Due from 2026-01-01')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Due from 2026-01-01' }));
    const url = String(replace.mock.calls[0]?.[0]);
    expect(url).not.toContain('dueAfter');
    expect(url).toContain('dueBefore=2026-02-01');
    expect(url).toContain('status=overdue');
  });

  it('the popover counts both due-date bounds and shows a read-only dueAfter row', () => {
    searchParamsStub = new URLSearchParams('dueAfter=2026-01-01&dueBefore=2026-02-01');
    renderWith({});
    expect(screen.getByTestId('invoice-more-filters-count')).toHaveTextContent('2');
    fireEvent.click(screen.getByTestId('invoice-more-filters-trigger'));
    const content = screen.getByTestId('filters-popover-content');
    expect(within(content).getByTestId('invoice-due-after-readout')).toHaveTextContent('2026-01-01');
    expect(within(content).getByRole('button', { name: 'Clear Due from 2026-01-01' })).toBeInTheDocument();
  });

  it('each read-only row is a group named by its label, so the value is announced with it', () => {
    searchParamsStub = new URLSearchParams('dueAfter=2026-01-01&dueBefore=2026-02-01');
    renderWith({});
    fireEvent.click(screen.getByTestId('invoice-more-filters-trigger'));
    const popover = screen.getByTestId('filters-popover-content');
    const dueFrom = within(popover).getByRole('group', { name: 'Due from' });
    expect(within(dueFrom).getByTestId('invoice-due-after-readout')).toHaveTextContent('2026-01-01');
    const dueBefore = within(popover).getByRole('group', { name: 'Due before' });
    expect(within(dueBefore).getByTestId('invoice-due-before-readout')).toHaveTextContent('2026-02-01');
  });

  it('the plan row is a group named Plan holding the plan readout', () => {
    searchParamsStub = new URLSearchParams('plan=corporate-gold&subject=membership');
    renderWith({ planFilter: { id: 'corporate-gold', label: 'Corporate Gold' } });
    fireEvent.click(screen.getByTestId('invoice-more-filters-trigger'));
    const popover = screen.getByTestId('filters-popover-content');
    const plan = within(popover).getByRole('group', { name: f.plan.label });
    expect(within(plan).getByTestId('invoice-plan-readout')).toHaveTextContent('Corporate Gold');
  });

  it('a malformed ?dueAfter, or the portal shape, renders no chip', () => {
    searchParamsStub = new URLSearchParams('dueAfter=2026-02-30');
    renderWith({});
    expect(screen.queryByText(/^Due from/)).toBeNull();

    searchParamsStub = new URLSearchParams('dueAfter=2026-01-01');
    renderWith({ showDueDateFilters: false });
    expect(screen.queryByText(/^Due from/)).toBeNull();
  });

  it('a resolved plan shows its name as a chip whose ✕ clears just ?plan', () => {
    searchParamsStub = new URLSearchParams('plan=corporate-gold&subject=membership');
    renderWith({ planFilter: { id: 'corporate-gold', label: 'Corporate Gold' } });
    expect(screen.getByText('Plan: Corporate Gold')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Plan: Corporate Gold' }));
    const url = String(replace.mock.calls[0]?.[0]);
    expect(url).not.toContain('plan=');
    expect(url).toContain('subject=membership');
  });

  it('dueAfter alone, or a plan alone, still offers Clear filters', () => {
    searchParamsStub = new URLSearchParams('dueAfter=2026-01-01');
    const { unmount } = renderWith({ show088Filters: false });
    expect(screen.getByRole('button', { name: f.clearAll })).toBeInTheDocument();
    unmount();

    searchParamsStub = new URLSearchParams('plan=corporate-gold');
    renderWith({ show088Filters: false, planFilter: { id: 'corporate-gold', label: 'Corporate Gold' } });
    expect(screen.getByRole('button', { name: f.clearAll })).toBeInTheDocument();
  });

  it('Clear filters drops dueAfter and plan with the rest', () => {
    searchParamsStub = new URLSearchParams('dueAfter=2026-01-01&plan=corporate-gold&status=overdue');
    renderWith({ show088Filters: false, planFilter: { id: 'corporate-gold', label: 'Corporate Gold' } });
    fireEvent.click(screen.getByRole('button', { name: f.clearAll }));
    const url = String(replace.mock.calls.at(-1)?.[0]);
    expect(url).not.toContain('dueAfter');
    expect(url).not.toContain('plan=');
    expect(url).not.toContain('status=');
  });
});

