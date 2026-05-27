/**
 * F9 US4 (review-run I-6) — <BenefitUsageCard> component tests.
 *
 * Deterministic presentation coverage the E2E (data-drifting against the live
 * tenant) can't give:
 *   - AS-1: a quantifiable benefit with an actionHref renders a compose deep
 *     link (with SR-context label), and the used/entitlement readout shows.
 *   - AS-3: active/unlimited benefits render as badges, no numeric quota.
 *   - AS-2: the under-use warning renders only when flagged.
 *   - AS-4: staff actions render only when the slot is provided (member vs
 *     admin differential) — guards against shipping the action as a no-op or
 *     leaking it to members.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import {
  BenefitUsageCard,
  type BenefitUsageCardProps,
} from '@/components/benefits/benefit-usage-card';
import enMessages from '@/i18n/messages/en.json';

function renderCard(props: Partial<BenefitUsageCardProps> = {}) {
  const base: BenefitUsageCardProps = {
    locale: 'en',
    membershipYear: 2026,
    elapsedYearPct: 62,
    quantifiable: [
      { key: 'eblast', used: 2, entitlement: 6, lastUsedAt: '2026-03-01T00:00:00.000Z', actionHref: '/portal/benefits/e-blasts' },
    ],
    active: [{ key: 'directory_listing' }],
    aggregateConsumedPct: 33,
    underUseWarning: false,
  };
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BenefitUsageCard {...base} {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<BenefitUsageCard>', () => {
  it('AS-1: renders a compose deep link for the eblast benefit with SR context', () => {
    renderCard();
    const link = screen.getByRole('link', { name: /compose/i });
    expect(link).toHaveAttribute('href', '/portal/benefits/e-blasts');
    // SR-context: the accessible name names the benefit, not bare "Compose".
    expect(link).toHaveAccessibleName(/e-blasts/i);
  });

  it('AS-1: shows the used/entitlement readout + last-used date', () => {
    renderCard();
    expect(screen.getByText(/2 of 6 used/i)).toBeInTheDocument();
    expect(screen.getByText(/last used/i)).toBeInTheDocument();
  });

  it('AS-3: active benefits render as badges (no numeric quota)', () => {
    renderCard();
    expect(screen.getByText('Directory listing')).toBeInTheDocument();
  });

  it('AS-2: the under-use warning renders only when flagged', () => {
    renderCard({ underUseWarning: false });
    expect(screen.queryByText(/not using all your benefits/i)).not.toBeInTheDocument();
    renderCard({ underUseWarning: true });
    expect(screen.getByText(/not using all your benefits/i)).toBeInTheDocument();
  });

  it('AS-4: staff actions render only when the slot is provided', () => {
    const { unmount } = renderCard();
    expect(screen.queryByRole('button', { name: /send reminder/i })).not.toBeInTheDocument();
    unmount();
    renderCard({ staffActions: <button type="button">Send reminder</button> });
    expect(screen.getByRole('button', { name: /send reminder/i })).toBeInTheDocument();
  });

  it('empty plan → empty-state title + description (no progress bars)', () => {
    renderCard({ quantifiable: [], active: [] });
    expect(screen.getByText('No tracked benefits')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
