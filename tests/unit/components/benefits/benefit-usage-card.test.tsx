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

  it('AS-1: an unused benefit (lastUsedAt null) shows "not used yet", not a date', () => {
    renderCard({
      quantifiable: [{ key: 'eblast', used: 0, entitlement: 6, lastUsedAt: null }],
    });
    expect(screen.getByText(/not used yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/last used/i)).not.toBeInTheDocument();
  });

  it('AS-2: warningActionHref renders a deep link inside the warning', () => {
    renderCard({
      underUseWarning: true,
      aggregateConsumedPct: 33,
      warningActionHref: '/portal/benefits/e-blasts',
    });
    const action = screen.getByRole('link', { name: /use a benefit/i });
    expect(action).toHaveAttribute('href', '/portal/benefits/e-blasts');
  });

  it('AS-5: the card title reflects the supplied membership year (rollover)', () => {
    renderCard({ membershipYear: 2027, elapsedYearPct: 0 });
    expect(screen.getByText(/2027/)).toBeInTheDocument();
  });

  // --- Pass A · Section 2 — compact preview mode -------------------------

  it('compact: keeps the quota progress bars but hides the live freshness note', () => {
    renderCard({ compact: true });
    // Quota readout still shows in compact mode.
    expect(screen.getByText(/2 of 6 used/i)).toBeInTheDocument();
    // Freshness note (live-computed caption) is omitted in the compact preview.
    expect(
      screen.queryByText(enMessages.benefits.card.liveNote),
    ).not.toBeInTheDocument();
  });

  it('compact: suppresses per-benefit action deep links (showActions=false)', () => {
    renderCard({ compact: true });
    expect(
      screen.queryByRole('link', { name: /compose/i }),
    ).not.toBeInTheDocument();
  });

  it('compact: renders the "full benefits" link when previewHref is supplied', () => {
    renderCard({ compact: true, previewHref: '/admin/members/m1/benefits' });
    const link = screen.getByRole('link', { name: /full benefits/i });
    expect(link).toHaveAttribute('href', '/admin/members/m1/benefits');
  });

  it('compact: hides the active-benefits badge section (summary stays tight)', () => {
    renderCard({ compact: true, active: [{ key: 'directory_listing' }] });
    expect(screen.queryByText('Directory listing')).not.toBeInTheDocument();
  });

  // --- 059-membership-suspension Task 18 — suspended-membership badge -----

  describe('suspended badge', () => {
    it('renders the amber Suspended badge + SR text when suspended=true', () => {
      renderCard({ suspended: true });
      expect(screen.getByText('Suspended')).toBeInTheDocument();
      expect(
        screen.getByText('Membership suspended — benefits paused'),
      ).toBeInTheDocument();
    });

    it('renders NO Suspended badge when suspended=false', () => {
      renderCard({ suspended: false });
      expect(screen.queryByText('Suspended')).not.toBeInTheDocument();
    });

    it('renders NO Suspended badge when suspended is omitted (default)', () => {
      renderCard();
      expect(screen.queryByText('Suspended')).not.toBeInTheDocument();
    });

    it('uses an amber (warning) colour token, never destructive red', () => {
      renderCard({ suspended: true });
      const badge = screen.getByText('Suspended').closest('span[class]');
      expect(badge).not.toBeNull();
      expect(badge?.className).toMatch(/text-warning/);
      expect(badge?.className).not.toMatch(/text-destructive/);
    });

    it('renders in compact mode too (inline member-detail preview surface)', () => {
      renderCard({ compact: true, suspended: true });
      expect(screen.getByText('Suspended')).toBeInTheDocument();
    });
  });
});
