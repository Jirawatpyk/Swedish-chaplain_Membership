/**
 * F114 — `<ChangeRequestStatusBadge>` takes ONE status union (PR-3 types I3):
 * `pending` · `decided` + outcome · `withdrawn` + reason — pairs that cannot
 * co-occur are not expressible, and `changeRequestStatusOf(row)` is the one
 * projection from a flat row / view. The fail-soft arm for a `decided` row
 * with no outcome (unreachable under the DB CHECK) stays and renders the
 * pending badge rather than throwing in a list of 100 rows.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ChangeRequestStatusBadge, changeRequestStatusOf } from '@/components/members/change-requests/change-request-status-badge';

const staff = enMessages.admin.changeRequests.review;

function renderBadge(status: ReturnType<typeof changeRequestStatusOf>) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ChangeRequestStatusBadge status={status} audience="staff" />
    </NextIntlClientProvider>,
  );
}

describe('changeRequestStatusOf → <ChangeRequestStatusBadge>', () => {
  it('pending', () => {
    expect(changeRequestStatusOf({ state: 'pending', outcome: null, withdrawnReason: null })).toEqual({ state: 'pending' });
    renderBadge({ state: 'pending' });
    expect(screen.getByText(staff.state.pending).closest('[data-state]')).toHaveAttribute('data-state', 'pending');
  });

  it('decided carries its outcome; withdrawn carries its reason — the other column is not on the variant', () => {
    expect(changeRequestStatusOf({ state: 'decided', outcome: 'partially_approved', withdrawnReason: null })).toEqual({ state: 'decided', outcome: 'partially_approved' });
    expect(changeRequestStatusOf({ state: 'withdrawn', outcome: null, withdrawnReason: 'replaced' })).toEqual({ state: 'withdrawn', withdrawnReason: 'replaced' });
    renderBadge({ state: 'decided', outcome: 'rejected' });
    expect(screen.getByText(staff.outcome.rejected).closest('[data-state]')).toHaveAttribute('data-outcome', 'rejected');
  });

  it('withdrawn: the reason names the badge; a reason-less row falls back to the plain state label', () => {
    const { unmount } = renderBadge({ state: 'withdrawn', withdrawnReason: 'replaced' });
    expect(screen.getByText(staff.withdrawn.replaced)).toBeTruthy();
    unmount();
    renderBadge({ state: 'withdrawn', withdrawnReason: null });
    expect(screen.getByText(staff.state.withdrawn)).toBeTruthy();
  });

  it('the fail-soft arm: a decided row with NO outcome (unreachable under the DB CHECK) renders the pending badge, never throws', () => {
    renderBadge({ state: 'decided', outcome: null });
    expect(screen.getByText(staff.state.pending).closest('[data-state]')).toHaveAttribute('data-state', 'decided');
  });
});

describe('<ChangeRequestStatusBadge> on AURA (spec 122 US3)', () => {
  it.each([
    [{ state: 'pending' } as const, 'aura-pill--progress', staff.state.pending],
    [{ state: 'decided', outcome: 'approved' } as const, 'aura-pill--ready', staff.outcome.approved],
    [{ state: 'decided', outcome: 'partially_approved' } as const, 'aura-pill--warning', staff.outcome.partially_approved],
    [{ state: 'decided', outcome: 'rejected' } as const, 'aura-pill--blocked', staff.outcome.rejected],
    [{ state: 'withdrawn', withdrawnReason: null } as const, 'aura-pill--neutral', staff.state.withdrawn],
  ])('draws %o as an AURA status pill (%s) with an icon and its word', (status, tone, word) => {
    renderBadge(status);
    const pill = screen.getByText(word).closest('.aura-pill')!;
    expect(pill).toHaveClass(tone);
    expect(pill).toHaveAttribute('data-state', status.state);
    expect(pill.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
