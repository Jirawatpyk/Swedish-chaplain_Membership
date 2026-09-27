/**
 * Spec 122 US3 — the member Benefits tab as the `Benefits` board draws it: a
 * page-level heading, one card per tracked benefit (h3, description, big used
 * figure, bar, next step), and an "Included benefits" card naming the plan.
 * The under-use warning (FR-021) still shows when flagged.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { PortalBenefitsPanel, type PortalBenefitsPanelProps } from '@/components/benefits/portal-benefits-panel';
import enMessages from '@/i18n/messages/en.json';

function renderPanel(over: Partial<PortalBenefitsPanelProps> = {}) {
  const props: PortalBenefitsPanelProps = {
    locale: 'en',
    membershipYear: 2026,
    elapsedYearPct: 74,
    quantifiable: [
      { key: 'eblast', used: 2, entitlement: 6, lastUsedAt: '2026-07-03T08:00:00.000Z', actionHref: '/portal/broadcasts/new' },
      { key: 'cultural_tickets', used: 0, entitlement: 2, lastUsedAt: null },
    ],
    active: [{ key: 'directory_listing' }, { key: 'm2m_benefits' }],
    aggregateConsumedPct: 20,
    underUseWarning: false,
    planName: 'Premium Corporate',
    ...over,
  };
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PortalBenefitsPanel {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<PortalBenefitsPanel>', () => {
  it('draws one card per tracked benefit: h3, description, the used figure, a named bar and the next step', () => {
    renderPanel();
    expect(screen.getByRole('heading', { level: 2, name: 'Benefit usage · 2026' })).toBeInTheDocument();
    const eblast = screen.getByRole('heading', { level: 3, name: 'E-Blasts' }).closest('.aura-card') as HTMLElement;
    expect(within(eblast).getByText("Email campaigns sent to the chamber's audience on your behalf")).toBeInTheDocument();
    expect(within(eblast).getByText('of 6 used')).toBeInTheDocument();
    expect(within(eblast).getByRole('progressbar', { name: 'E-Blasts used' })).toBeInTheDocument();
    expect(within(eblast).getByRole('link', { name: 'Compose E-Blast' })).toHaveClass('aura-btn', 'aura-btn--secondary');
    expect(screen.getByRole('heading', { level: 3, name: 'Cultural event tickets' })).toBeInTheDocument();
  });

  it('lists the included benefits in their own card, naming the plan', () => {
    renderPanel();
    const card = screen.getByRole('heading', { level: 2, name: 'Included benefits' }).closest('.aura-card') as HTMLElement;
    expect(within(card).getByText('Part of your Premium Corporate plan for 2026')).toBeInTheDocument();
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    expect(within(card).getByText('Directory E-Book listing')).toBeInTheDocument();
  });

  it('keeps the under-use warning when flagged (FR-021)', () => {
    renderPanel({ underUseWarning: true });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
