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
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';

beforeEach(() => vi.useRealTimers());

function renderEmpty(props?: {
  suspendedInWindowCount?: number;
  suspendedOutsideWindowCount?: number;
  canManageSchedules?: boolean;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <RenewalsEmptyState canManageSchedules {...props} />
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

/**
 * The "Review schedule settings" link targets
 * `/admin/settings/renewals/schedules`, gated on
 * `settings.renewal_schedules` — which manager lacks, so a manager who
 * followed it hit a 404. The link follows the evaluated permission.
 */
describe('RenewalsEmptyState × settings.renewal_schedules', () => {
  function renderAs(role: 'manager' | 'admin') {
    return renderEmpty({
      canManageSchedules: hasPermission(role, 'settings.renewal_schedules'),
    });
  }

  it('manager: the schedule-settings link is hidden; the members CTA stays', () => {
    renderAs('manager');
    expect(
      screen.queryByRole('link', { name: en.admin.renewals.empty.settingsLink }),
    ).toBeNull();
    expect(
      screen.getByRole('link', { name: en.admin.renewals.empty.cta }),
    ).toHaveAttribute('href', '/admin/members');
  });

  it('admin: the schedule-settings link renders', () => {
    renderAs('admin');
    expect(
      screen.getByRole('link', { name: en.admin.renewals.empty.settingsLink }),
    ).toHaveAttribute('href', '/admin/settings/renewals/schedules');
  });
});
