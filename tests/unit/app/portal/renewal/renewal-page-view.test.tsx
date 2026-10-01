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
  it('heads the page "Online renewal" (hero size, as the board) with the board subtitle', () => {
    renderView();
    const h1 = screen.getByRole('heading', { level: 1, name: 'Online renewal' });
    expect(h1.closest('[data-size]')).toHaveAttribute('data-size', 'hero');
    expect(
      screen.getByText('Review your membership and confirm to receive an invoice.'),
    ).toBeInTheDocument();
  });

  it('shows the first-renewal welcome as an AURA info alert, only for a first renewal', () => {
    const first = renderView({ isFirstTimeRenewer: true });
    const welcome = screen.getByRole('note');
    expect(welcome.className).toMatch(/aura-alert--info/);
    expect(welcome.textContent).toContain('Welcome to your first renewal');
    expect(welcome.textContent).toContain('Your renewal price is locked at the rate');
    // UX review: no aria-label repeating the visible title (read twice).
    expect(welcome).not.toHaveAttribute('aria-label');
    first.unmount();
    renderView();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('"Membership plan" is an AURA card (h2) with plan, tier badge, term and expiry', () => {
    renderView();
    const card = screen.getByRole('region', { name: 'Membership plan' });
    expect(card.className).toMatch(/aura-card/);
    expect(within(card).getByRole('heading', { level: 2, name: 'Membership plan' })).toBeInTheDocument();
    // Board: two columns, each label stacked over its value, on a phone too.
    const dl = card.querySelector('dl')!;
    expect(dl.className).toMatch(/grid-cols-2/);
    expect(dl.querySelectorAll(':scope > div')).toHaveLength(4);
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

  it('shows each gate notice as an h2 card in place of the confirm card (UX review)', () => {
    const cases = [
      ['pending_review', enMessages.portal.renewal.pendingReviewTitle, enMessages.portal.renewal.pendingReviewBody, 'info'],
      ['rejected_refund', enMessages.portal.renewal.rejectedRefundTitle, enMessages.portal.renewal.rejectedRefundBody, 'warning'],
      ['not_yet_open', enMessages.portal.renewal.notYetOpenTitle, enMessages.portal.renewal.notYetOpenBody, 'info'],
    ] as const;
    for (const [kind, title, body, tone] of cases) {
      const view = renderView({ gate: { kind } });
      expect(screen.queryByRole('region', { name: 'Confirm' })).toBeNull();
      const card = screen.getByRole('region', { name: title });
      expect(within(card).getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
      const alert = card.querySelector('.aura-alert')!;
      expect(alert.className).toMatch(new RegExp(`aura-alert--${tone}`));
      expect(alert.textContent).toContain(body);
      view.unmount();
    }
  });
});
