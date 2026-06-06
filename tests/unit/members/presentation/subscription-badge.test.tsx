/**
 * Pass A · Section 3 — `SubscriptionBadge` presentational unit spec.
 *
 * Surfaces a contact's F7 marketing-subscription status so admins know,
 * BEFORE assuming a member receives E-Blasts, whether they have
 * unsubscribed (PDPA/GDPR Art. 21). The state is conveyed by a visible
 * TEXT label (Subscribed / Unsubscribed), never colour-alone (WCAG 1.4.1).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SubscriptionBadge } from '@/components/members/subscription-badge';

const messages = {
  admin: {
    members: {
      detail: {
        subscription: {
          subscribed: 'Subscribed',
          unsubscribed: 'Unsubscribed',
          unsubscribedAria: 'This contact has unsubscribed from E-Blasts',
          unknown: 'Status unavailable',
          unknownAria: 'Subscription status is temporarily unavailable',
        },
      },
    },
  },
};

function renderBadge(subscribed: boolean | 'unknown') {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SubscriptionBadge subscribed={subscribed} />
    </NextIntlClientProvider>,
  );
}

describe('SubscriptionBadge (Pass A · Section 3 / S1)', () => {
  it('renders a "Subscribed" text label when subscribed', () => {
    renderBadge(true);
    expect(screen.getByText('Subscribed')).toBeInTheDocument();
    expect(screen.queryByText('Unsubscribed')).not.toBeInTheDocument();
    expect(screen.queryByText('Status unavailable')).not.toBeInTheDocument();
  });

  it('renders an "Unsubscribed" text label when unsubscribed', () => {
    renderBadge(false);
    expect(screen.getByText('Unsubscribed')).toBeInTheDocument();
    expect(screen.queryByText('Subscribed')).not.toBeInTheDocument();
    expect(screen.queryByText('Status unavailable')).not.toBeInTheDocument();
  });

  // S1 — degraded read: the badge must NOT falsely assert "Subscribed".
  it('renders a neutral "Status unavailable" TEXT label when unknown', () => {
    renderBadge('unknown');
    // WCAG 1.4.1 — meaning carried by a visible text label, not colour alone.
    expect(screen.getByText('Status unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Subscribed')).not.toBeInTheDocument();
    expect(screen.queryByText('Unsubscribed')).not.toBeInTheDocument();
  });
});
