/**
 * Pass A · Section 1 — `RenewalHealthCard` presentational unit spec.
 *
 * Pure client component fed plain serializable props by the async server
 * wrapper (`MemberRenewalHealthSection`). Covers the three render states
 * the card must handle: empty (no cycle), populated (status + expiry +
 * days remaining + engagement), and engagement-absent (F9 flag off).
 *
 * Accessibility: status + engagement band carry a visible TEXT label
 * (never colour-alone) per FR-035 / WCAG 1.4.1.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { RenewalHealthCard } from '@/components/members/renewal-health-card';

// Stub the lapsed-comeback dialog to a plain button so the card test stays
// isolated from Base UI Dialog + next/navigation + sonner internals. Cluster 7
// (G18) asserts this trigger is SUPPRESSED when the renewal read failed.
vi.mock('@/components/members/renew-lapsed-member-dialog', () => ({
  RenewLapsedMemberDialog: ({ memberId }: { memberId: string }) => (
    <button type="button" data-testid="renew-lapsed-trigger">
      Renew member ({memberId})
    </button>
  ),
}));

const messages = {
  admin: {
    members: {
      detail: {
        renewalHealth: {
          title: 'Renewal & Health',
          empty: 'No active renewal cycle',
          readFailed: "We couldn't load this member's renewal status. Please try again.",
          status: 'Status',
          expiry: 'Expiry',
          daysRemaining: '{days} days remaining',
          overdueDays: 'Overdue by {days} days',
          engagement: 'Engagement',
          viewRenewal: 'View renewal',
          cycleStatus: {
            upcoming: 'Upcoming',
            reminded: 'Reminded',
            awaiting_payment: 'Awaiting payment',
            pending_admin_reactivation: 'Pending reactivation',
            completed: 'Completed',
            lapsed: 'Lapsed',
            cancelled: 'Cancelled',
          },
        },
      },
      directory: {
        engagementBand: {
          healthy: 'Healthy',
          moderate: 'Moderate',
          warning: 'Watch',
          critical: 'Critical',
        },
      },
    },
  },
};

function renderCard(
  props: Omit<React.ComponentProps<typeof RenewalHealthCard>, 'headingId'>,
) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      timeZone="Asia/Bangkok"
    >
      <RenewalHealthCard headingId="renewal-health-heading" {...props} />
    </NextIntlClientProvider>,
  );
}

describe('RenewalHealthCard (Pass A · Section 1)', () => {
  it('renders the empty state when there is no cycle', () => {
    renderCard({
      status: null,
      expiryIso: null,
      daysRemaining: null,
      engagementScore: null,
      engagementBand: null,
      viewHref: '/admin/renewals',
    });
    expect(screen.getByText('No active renewal cycle')).toBeInTheDocument();
    // No status badge in the empty state.
    expect(screen.queryByText('Awaiting payment')).not.toBeInTheDocument();
  });

  it('renders status, expiry, days remaining, and engagement when populated', () => {
    renderCard({
      status: 'awaiting_payment',
      expiryIso: '2026-07-15T00:00:00.000Z',
      daysRemaining: 20,
      engagementScore: 82,
      engagementBand: 'healthy',
      viewHref: '/admin/renewals',
    });
    expect(screen.getByText('Awaiting payment')).toBeInTheDocument();
    expect(screen.getByText('20 days remaining')).toBeInTheDocument();
    // Engagement score + band text (band is a text label, not colour-only).
    expect(screen.getByText('82')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    // View-renewal link present.
    const link = screen.getByRole('link', { name: /View renewal/ });
    expect(link).toHaveAttribute('href', '/admin/renewals');
  });

  it('shows an overdue label when days remaining is negative', () => {
    renderCard({
      status: 'lapsed',
      expiryIso: '2026-05-01T00:00:00.000Z',
      daysRemaining: -12,
      engagementScore: null,
      engagementBand: null,
      viewHref: '/admin/renewals',
    });
    expect(screen.getByText('Lapsed')).toBeInTheDocument();
    expect(screen.getByText('Overdue by 12 days')).toBeInTheDocument();
  });

  it('omits the engagement line when engagement is absent (F9 flag off)', () => {
    renderCard({
      status: 'upcoming',
      expiryIso: '2026-09-01T00:00:00.000Z',
      daysRemaining: 90,
      engagementScore: null,
      engagementBand: null,
      viewHref: '/admin/renewals',
    });
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    // No engagement label rendered when score+band are both null.
    expect(screen.queryByText('Engagement')).not.toBeInTheDocument();
  });

  // Cluster 7 (G18) — a FAILED renewal read must render a distinct
  // "unavailable" state, NOT the empty state (which lies — it says the member
  // has no cycle when in fact the read errored), and must suppress the
  // lapsed-comeback action (status is null only because the read failed).
  it('renders the readFailed copy (NOT the empty state, dl, or renew action) when readFailed', () => {
    renderCard({
      readFailed: true,
      // canRenew + memberId supplied and status null (isLapsed) — the action
      // must STILL be suppressed because the read failed.
      canRenew: true,
      memberId: 'm1',
      status: null,
      expiryIso: null,
      daysRemaining: null,
      engagementScore: null,
      engagementBand: null,
      viewHref: '/admin/renewals',
    });
    expect(
      screen.getByText("We couldn't load this member's renewal status. Please try again."),
    ).toBeInTheDocument();
    // NOT the empty-state copy.
    expect(screen.queryByText('No active renewal cycle')).not.toBeInTheDocument();
    // NOT the status <dl> (no status/expiry rows).
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
    // NOT the renew-action trigger.
    expect(screen.queryByTestId('renew-lapsed-trigger')).not.toBeInTheDocument();
  });

  it('still renders the empty state when readFailed is false and status is null (regression guard)', () => {
    renderCard({
      readFailed: false,
      status: null,
      expiryIso: null,
      daysRemaining: null,
      engagementScore: null,
      engagementBand: null,
      viewHref: '/admin/renewals',
    });
    expect(screen.getByText('No active renewal cycle')).toBeInTheDocument();
    expect(
      screen.queryByText("We couldn't load this member's renewal status. Please try again."),
    ).not.toBeInTheDocument();
  });

  // 056 fix #1 — the title is a real <h2> (not a CardTitle <div>) wired to the
  // wrapping <section aria-labelledby>, so SR heading-nav can reach the card.
  it('renders the title as a real <h2> heading with the supplied id', () => {
    renderCard({
      status: 'upcoming',
      expiryIso: '2026-09-01T00:00:00.000Z',
      daysRemaining: 90,
      engagementScore: null,
      engagementBand: null,
      viewHref: '/admin/renewals',
    });
    const heading = screen.getByRole('heading', {
      level: 2,
      name: /Renewal & Health/,
    });
    expect(heading).toHaveAttribute('id', 'renewal-health-heading');
  });
});
