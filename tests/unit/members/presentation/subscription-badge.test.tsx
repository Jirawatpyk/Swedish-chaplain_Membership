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
        },
      },
    },
  },
};

function renderBadge(subscribed: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SubscriptionBadge subscribed={subscribed} />
    </NextIntlClientProvider>,
  );
}

describe('SubscriptionBadge (Pass A · Section 3)', () => {
  it('renders a "Subscribed" text label when subscribed', () => {
    renderBadge(true);
    expect(screen.getByText('Subscribed')).toBeInTheDocument();
    expect(screen.queryByText('Unsubscribed')).not.toBeInTheDocument();
  });

  it('renders an "Unsubscribed" text label when unsubscribed', () => {
    renderBadge(false);
    expect(screen.getByText('Unsubscribed')).toBeInTheDocument();
    expect(screen.queryByText('Subscribed')).not.toBeInTheDocument();
  });
});
