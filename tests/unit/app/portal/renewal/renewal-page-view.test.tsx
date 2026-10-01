/**
 * Spec 122 US7c (T741) — the renewal page frame on AURA (board `Portal-renewal`).
 *
 * `RenewalPageView` is the page's presentation, split from the server data
 * loading so it renders here and in the preview harness: the h1, the
 * first-renewal welcome as an AURA info alert, "Membership plan" as an AURA
 * card with the tier as an accent badge, the benefit summary, and either the
 * confirm card or one of the gate notices, laid out in the board's two
 * columns from `lg`.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  RenewalPageView,
  type RenewalPageViewProps,
} from '@/app/(member)/portal/renewal/[memberId]/_components/renewal-page-view';

vi.mock('next/navigation', () => ({
  usePathname: () => '/portal/renewal/member-1',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  cleanup();
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

const FLOW = {
  memberId: 'member-1',
  cycleId: '00000000-0000-0000-0000-000000000001',
  currentPlanId: 'plan-premium',
  currentPlanLabel: 'Premium Corporate',
  availablePlans: [
    { planId: 'plan-premium', label: 'Premium Corporate', annualFeeMinorUnits: 3_600_000 },
  ],
  frozenPriceMinorUnits: 3_600_000,
  benefitUsage: {
    eblast: { used: 2, quota: 6 },
    culturalTickets: { used: 0, quota: 2 },
  },
};

const BASE: RenewalPageViewProps = {
  locale: 'en',
  isFirstTimeRenewer: false,
  plan: {
    label: 'Premium Corporate',
    tierLabel: 'Premium',
    termMonths: 12,
    expiresAt: '2026-12-31T00:00:00.000Z',
  },
  benefits: [],
  benefitsAvailable: false,
  gate: { kind: 'payable', flow: FLOW },
};

function renderView(overrides: Partial<RenewalPageViewProps> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      <RenewalPageView {...BASE} {...overrides} />
    </NextIntlClientProvider>,
  );
}

describe('<RenewalPageView> (board Portal-renewal, US7c)', () => {
  it('heads the page "Online renewal" with the board subtitle', () => {
    renderView();
    expect(screen.getByRole('heading', { level: 1, name: 'Online renewal' })).toBeInTheDocument();
    expect(
      screen.getByText('Review your membership and confirm to receive an invoice.'),
    ).toBeInTheDocument();
  });

  it('shows the first-renewal welcome as an AURA info alert, only for a first renewal', () => {
    const first = renderView({ isFirstTimeRenewer: true });
    const welcome = screen.getByRole('note', { name: 'Welcome to your first renewal' });
    expect(welcome.className).toMatch(/aura-alert--info/);
    expect(welcome.textContent).toContain('Your renewal price is locked at the rate');
    first.unmount();
    renderView();
    expect(screen.queryByRole('note', { name: 'Welcome to your first renewal' })).toBeNull();
  });

  it('"Membership plan" is an AURA card (h2) with plan, tier badge, term and expiry', () => {
    renderView();
    const card = screen.getByRole('region', { name: 'Membership plan' });
    expect(card.className).toMatch(/aura-card/);
    expect(within(card).getByRole('heading', { level: 2, name: 'Membership plan' })).toBeInTheDocument();
    const rows = [...card.querySelectorAll('dt')].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(rows).toEqual([
      ['Plan', 'Premium Corporate'],
      ['Tier', 'Premium'],
      ['Term', '12 months'],
      ['Current expiry', '31 December 2026'],
    ]);
    const badge = within(card).getByText('Premium', { selector: '.aura-badge' });
    expect(badge.className).toMatch(/aura-badge--accent/);
    expect(card.querySelector('time')).toHaveAttribute('datetime', '2026-12-31T00:00:00.000Z');
  });

  it('puts the confirm card in the right column of the board grid from lg', () => {
    renderView();
    const confirm = screen.getByRole('region', { name: 'Confirm' });
    expect(confirm.className).toMatch(/aura-card/);
    const grid = confirm.parentElement!;
    expect(grid.className).toMatch(/lg:grid-cols-\[minmax\(0,1fr\)_420px\]/);
    // The left column holds the plan and benefit cards.
    expect(within(grid).getByRole('region', { name: 'Membership plan' })).toBeInTheDocument();
    expect(within(grid).getByRole('region', { name: 'Benefit summary' })).toBeInTheDocument();
  });

  it('shows the gate notices as AURA alerts in place of the confirm card', () => {
    const pending = renderView({ gate: { kind: 'pending_review' } });
    expect(screen.queryByRole('region', { name: 'Confirm' })).toBeNull();
    expect(
      screen.getByRole('note', { name: enMessages.portal.renewal.pendingReviewTitle }).className,
    ).toMatch(/aura-alert--info/);
    pending.unmount();

    const refund = renderView({ gate: { kind: 'rejected_refund' } });
    expect(
      screen.getByRole('note', { name: enMessages.portal.renewal.rejectedRefundTitle }).className,
    ).toMatch(/aura-alert--warning/);
    refund.unmount();

    renderView({ gate: { kind: 'not_yet_open' } });
    const notYet = screen.getByRole('note', { name: enMessages.portal.renewal.notYetOpenTitle });
    expect(notYet.textContent).toContain(enMessages.portal.renewal.notYetOpenBody);
  });
});
