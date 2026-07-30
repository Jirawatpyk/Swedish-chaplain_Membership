/**
 * `RenewalsEmptyState` — A2 (renewals-suspended-visibility-audit UX
 * review): the empty state must NOT swallow the suspended-population
 * bridge. With `totalInWindow===0 && lapsedCount===0` this card replaces
 * the whole pipeline lens — exactly the launch-shaped tenant state (every
 * member a first-bill collection case OUTSIDE the 90-day window) where the
 * bridge matters most. Rendered with the REAL en.json (repo convention).
 *
 * `vi.useRealTimers()` — the shared harness installs fake timers that hang
 * React rendering (memory: component test harness fake timers).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { RenewalsEmptyState } from '@/app/(staff)/admin/renewals/_components/empty-state';

beforeEach(() => vi.useRealTimers());

function renderEmpty(props?: {
  suspendedInWindowCount?: number;
  suspendedOutsideWindowCount?: number;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <RenewalsEmptyState {...props} />
    </NextIntlClientProvider>,
  );
}

describe('RenewalsEmptyState × suspended bridge (A2)', () => {
  it('renders the empty-state card WITHOUT the bridge when no suspended cycles sit outside the window (true-empty tenant, byte-identical)', () => {
    renderEmpty();
    // The card's own content is present…
    expect(
      screen.getByRole('link', { name: en.admin.renewals.empty.cta }),
    ).toBeInTheDocument();
    // …and no bridge line / bills link exists.
    expect(screen.queryByText(/Suspended benefit access/)).toBeNull();
    expect(
      screen.queryByRole('link', { name: 'View all unpaid membership bills' }),
    ).toBeNull();
  });

  it('renders the SAME bridge strip (copy + honest link) beneath the card for the launch-shaped tenant', () => {
    renderEmpty({ suspendedInWindowCount: 0, suspendedOutsideWindowCount: 11 });
    // Card still shows — "no renewals due in the window" stays true…
    expect(
      screen.getByRole('link', { name: en.admin.renewals.empty.cta }),
    ).toBeInTheDocument();
    // …and the bridge explains where the 11 suspended members live.
    expect(
      screen.getByText(/Suspended benefit access: 11 members in total/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'View all unpaid membership bills' }),
    ).toHaveAttribute(
      'href',
      '/admin/invoices?status=issued&subject=membership',
    );
  });
});
