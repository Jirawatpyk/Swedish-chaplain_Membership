/**
 * 060-member-portal-d4 — `<InvoiceFilters>` configurability props.
 *
 * THE BUG (facets 2 + 3): the member portal mounted the admin `InvoiceFilters`
 * verbatim, exposing a 'Draft' status option (meaningless for members —
 * drafts are always excluded) and the 'Paid online' reconciliation chip (an
 * admin filter; a member who paid OFFLINE would see their invoices vanish).
 *
 * The fix makes the component configurable with two backward-compatible
 * props:
 *   - statusOptions (default = full admin vocabulary, so admin is unchanged)
 *   - showPaidOnlineChip (default = true, so admin is unchanged)
 *
 * These tests pin BOTH the admin defaults (so admin behaviour is unchanged)
 * and the portal subset (no draft option + no chip).
 *
 * Harness note: the status `<Select>` is a Base UI Select whose options live
 * in a `<Portal>` that only mounts on open — and jsdom can't drive Base UI's
 * pointer-based open. So we mock `@/components/ui/select` with lightweight
 * eager-render stubs (SelectContent → div, SelectItem → role="option") to
 * read the options the component *maps* directly, without portal/popup
 * gymnastics. The trigger + the chip are the real component output.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

// The client component reads URL state + pushes via the app router. Stub the
// navigation hooks the Next app shell would provide (no real router in jsdom).
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/portal/invoices',
}));

// Eager-render Select stubs so the mapped <SelectItem>s land in the DOM
// without opening Base UI's portal popup (which jsdom can't drive).
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: ReactNode;
  }) => (
    <div role="option" aria-selected={false} data-value={value}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  TranslatedSelectValue: () => null,
}));

import { InvoiceFilters } from '@/app/(staff)/admin/invoices/_components/invoice-filters';

function renderFilters(props?: Parameters<typeof InvoiceFilters>[0]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <InvoiceFilters {...props} />
    </NextIntlClientProvider>,
  );
}

/** Collect the `data-value` of every rendered status/subject option. */
function optionValues(): string[] {
  return screen
    .getAllByRole('option')
    .map((el) => el.getAttribute('data-value') ?? '');
}

describe('<InvoiceFilters> — admin defaults (unchanged)', () => {
  beforeEach(() => replace.mockClear());

  it('renders the full status vocabulary incl. draft + overdue by default', () => {
    renderFilters();
    const values = optionValues();
    // Full admin vocabulary present (alongside the always-present 'all' +
    // subject options 'membership'/'event').
    for (const s of [
      'draft',
      'issued',
      'paid',
      'overdue',
      'void',
      'credited',
      'partially_credited',
    ]) {
      expect(values).toContain(s);
    }
  });

  it('renders the Paid online chip by default', () => {
    renderFilters();
    expect(screen.getByTestId('paid-online-filter-chip')).toBeInTheDocument();
  });
});

describe('<InvoiceFilters> — member portal config', () => {
  beforeEach(() => replace.mockClear());

  it('omits the draft option but keeps overdue when statusOptions excludes draft', () => {
    renderFilters({
      statusOptions: [
        'issued',
        'paid',
        'overdue',
        'void',
        'credited',
        'partially_credited',
      ],
      showPaidOnlineChip: false,
    });
    const values = optionValues();
    // Draft is gone…
    expect(values).not.toContain('draft');
    // …but overdue (the now-working derived filter) and the rest remain.
    expect(values).toContain('overdue');
    expect(values).toContain('issued');
    expect(values).toContain('paid');
    expect(values).toContain('void');
    expect(values).toContain('credited');
    expect(values).toContain('partially_credited');
  });

  it('does NOT render the Paid online chip when showPaidOnlineChip is false', () => {
    renderFilters({ showPaidOnlineChip: false });
    expect(screen.queryByTestId('paid-online-filter-chip')).not.toBeInTheDocument();
  });
});
