/**
 * Spec 122 US3 — the dashboard's Benefit usage card, as the portal `Main`
 * board draws it: a bar per benefit with its last use as the bar's hint, the
 * benefit's next step as a named secondary button, and "Full benefits" in the
 * body. It never repeats the under-use warning the Benefits stat already
 * carries.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { PortalBenefitsSummaryCard } from '@/components/benefits/portal-benefits-summary-card';
import enMessages from '@/i18n/messages/en.json';

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PortalBenefitsSummaryCard
        locale="en"
        membershipYear={2026}
        fullHref="/portal/benefits"
        quantifiable={[
          { key: 'eblast', used: 2, entitlement: 6, lastUsedAt: '2026-07-03T08:00:00.000Z', actionHref: '/portal/broadcasts/new' },
          { key: 'cultural_tickets', used: 0, entitlement: 2, lastUsedAt: null },
        ]}
      />
    </NextIntlClientProvider>,
  );
}

describe('<PortalBenefitsSummaryCard>', () => {
  it('draws a bar per benefit with its last use as the hint', () => {
    renderCard();
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
    expect(screen.getByText('2 of 6 used')).toBeInTheDocument();
    expect(screen.getByText(/Last used 3 Jul 2026/)).toBeInTheDocument();
    expect(screen.getByText('Not used yet this year')).toBeInTheDocument();
  });

  it('offers the benefit’s next step as a named secondary button, only where there is one', () => {
    renderCard();
    const compose = screen.getByRole('link', { name: 'Compose E-Blast' });
    expect(compose).toHaveAttribute('href', '/portal/broadcasts/new');
    expect(compose).toHaveClass('aura-btn', 'aura-btn--secondary');
    expect(screen.queryByRole('link', { name: 'View events' })).toBeNull();
  });

  it('links to the full benefits page and shows no under-use warning', () => {
    renderCard();
    expect(screen.getByRole('link', { name: /Full benefits/ })).toHaveAttribute('href', '/portal/benefits');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
