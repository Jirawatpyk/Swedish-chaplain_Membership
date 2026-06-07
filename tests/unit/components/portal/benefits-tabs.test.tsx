/**
 * 058 — BenefitsTabs F7 kill-switch regression lock.
 *
 * Guards the `showBroadcastsTab` prop contract:
 *   - true  → both Benefits + Broadcasts tabs rendered (F7 on, normal)
 *   - false → only Benefits tab rendered; Broadcasts trigger + panel absent
 *             (F7 kill-switch, env.features.f7Broadcasts === false)
 *
 * Provider pattern: NextIntlClientProvider backed by real en.json so
 * `t('benefits')` / `t('broadcasts')` / `t('ariaLabel')` resolve to their
 * actual label strings ("Benefits", "Broadcasts", "Benefits sections").
 * A dangling t() ref would surface as a MISSING_MESSAGE error rather than
 * passing silently — identical reasoning to the portal-sign-out-button test.
 *
 * Fake-timers note: setup.ts installs fake timers globally. BenefitsTabs
 * uses `useTransition` (React internals) + `router.replace` (mocked). The
 * real timers bracket (useRealTimers/useFakeTimers in beforeEach/afterEach)
 * is applied to keep waitFor-style promise resolution reliable, matching the
 * pattern in portal-sign-out-button.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { BenefitsTabs } from '@/app/(member)/portal/benefits/_components/benefits-tabs';
import { BENEFITS_TAB } from '@/app/(member)/portal/benefits/_helpers/tabs';

// ---------------------------------------------------------------------------
// next/navigation mock — BenefitsTabs calls useRouter().replace on tab change
// ---------------------------------------------------------------------------
const replaceSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceSpy }),
}));

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderTabs({
  showBroadcastsTab,
  broadcastsPanel,
}: {
  showBroadcastsTab: boolean;
  broadcastsPanel?: React.ReactNode;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BenefitsTabs
        active={BENEFITS_TAB.benefits}
        showBroadcastsTab={showBroadcastsTab}
        benefitsPanel={<div data-testid="benefits-body">benefits body</div>}
        broadcastsPanel={broadcastsPanel ?? <div data-testid="bp">broadcasts panel</div>}
      />
    </NextIntlClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('<BenefitsTabs> — showBroadcastsTab F7 kill-switch (058)', () => {
  beforeEach(() => {
    // Real timers: setup.ts fakes setTimeout/clearTimeout globally; waitFor
    // and promise-resolution need real timers during async assertions.
    // Matches portal-sign-out-button.test.tsx pattern.
    vi.useRealTimers();
    replaceSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useFakeTimers();
  });

  // -------------------------------------------------------------------------
  // Case 1 — F7 ON: both tabs visible
  // -------------------------------------------------------------------------

  it('showBroadcastsTab=true → renders 2 tabs (Benefits + Broadcasts)', () => {
    renderTabs({ showBroadcastsTab: true });
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /benefits/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /broadcasts/i })).toBeInTheDocument();
  });

  it('showBroadcastsTab=true → benefits panel body is present', () => {
    renderTabs({ showBroadcastsTab: true });
    expect(screen.getByTestId('benefits-body')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Case 2 — F7 OFF (kill-switch): only Benefits tab, no Broadcasts tab/panel
  // -------------------------------------------------------------------------

  it('showBroadcastsTab=false → renders exactly 1 tab (Benefits only)', () => {
    renderTabs({ showBroadcastsTab: false });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('showBroadcastsTab=false → Broadcasts tab is NOT rendered', () => {
    renderTabs({ showBroadcastsTab: false });
    expect(screen.queryByRole('tab', { name: /broadcasts/i })).toBeNull();
  });

  it('showBroadcastsTab=false → broadcasts panel content is NOT rendered', () => {
    renderTabs({
      showBroadcastsTab: false,
      broadcastsPanel: <div data-testid="bp">broadcasts panel</div>,
    });
    expect(screen.queryByTestId('bp')).toBeNull();
  });

  it('showBroadcastsTab=false → benefits panel body is still present', () => {
    renderTabs({ showBroadcastsTab: false });
    expect(screen.getByTestId('benefits-body')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Case 3 — tab labels resolve against real en.json (no MISSING_MESSAGE)
  // -------------------------------------------------------------------------

  it('tab labels resolve from real en.json — no raw key strings rendered', () => {
    renderTabs({ showBroadcastsTab: true });
    // If t() produced a raw key string, the tab text would contain 'benefits'
    // or 'broadcasts' literally but NOT as capitalized display strings.
    // Assert the resolved labels match the canonical en.json values.
    expect(screen.getByRole('tab', { name: 'Benefits' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Broadcasts' })).toBeInTheDocument();
  });
});
