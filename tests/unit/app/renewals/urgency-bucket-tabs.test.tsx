import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { UrgencyBucketTabs } from '@/app/(staff)/admin/renewals/_components/urgency-bucket-tabs';
import en from '@/i18n/messages/en.json';

// Module-level spy (not a fresh vi.fn() per useRouter() call) so tests can
// assert on push() invocations — a per-call spy can't be asserted because
// the component captures a different instance than the test observes.
// `month=2027-02` models a stale month-lens URL: it's a valid default for
// every test here since setting urgency + deleting month is correct
// regardless of whether month was present, and it's what the new
// exit-the-month-lens test needs to prove `?month` gets dropped.
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/admin/renewals',
  useSearchParams: () => new URLSearchParams('month=2027-02'),
}));

const COUNTS = { 't-90': 1, 't-60': 2, 't-30': 3, 't-14': 4, 't-7': 5, 't-0': 6, suspended: 7, terminated: 0 };

function renderTabs(current: 't-30' | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <UrgencyBucketTabs current={current} counts={COUNTS} lapsedCount={9} />
    </NextIntlClientProvider>,
  );
}

describe('UrgencyBucketTabs colour + All state', () => {
  it('tints the t-0 count badge with the red pill band class', () => {
    renderTabs('t-30');
    // The t-0 badge (count 6) carries a red-family class from VARIANT_CLASSES.
    const badge = screen.getByText('6');
    expect(badge.className).toMatch(/red/);
  });

  it('marks exactly the current tab active when current is a bucket', () => {
    const { container } = renderTabs('t-30');
    // Base UI Tabs (`@base-ui/react/tabs`) marks the active tab with
    // `aria-selected="true"` (NOT Radix's `data-state="active"`). This
    // positive case proves the selector is real + discriminating: it
    // finds exactly one active tab, and it's the T-30 trigger.
    const active = container.querySelectorAll('[aria-selected="true"]');
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveTextContent('T-30');
  });

  it('renders with no active tab when current is null (month lens active)', () => {
    const { container } = renderTabs(null);
    // `current ?? ''` → empty Tabs value → no tab is aria-selected.
    expect(container.querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
  });

  it('clicking an urgency tab exits the month lens (drops ?month)', () => {
    push.mockClear();
    renderTabs(null); // month lens active → tabs render "All" state
    fireEvent.click(screen.getByText('T-30'));
    expect(push).toHaveBeenCalledTimes(1);
    const url = push.mock.calls[0]![0] as string;
    expect(url).not.toContain('month=');
    expect(url).toContain('urgency=t-30');
    // Same-page filter → viewport must stay put (operator-reported: the
    // default scroll-to-top yanked the user away from the tab strip).
    expect(push.mock.calls[0]![1]).toEqual({ scroll: false });
  });
});

function renderDimmed() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <UrgencyBucketTabs current={null} counts={COUNTS} lapsedCount={9} monthLensActive />
    </NextIntlClientProvider>,
  );
}

describe('UrgencyBucketTabs month-lens paused state (item ③ — WCAG 1.4.3 review-fix)', () => {
  it('does NOT dim the urgency region (no opacity-60) while a month lens is active', () => {
    const { container } = renderDimmed();
    const region = container.querySelector('[role="region"]') as HTMLElement;
    expect(region.className).not.toMatch(/opacity-60/);
  });

  it('exposes a visible "Paused" badge (aria-hidden) while a month lens is active', () => {
    renderDimmed();
    const badge = screen.getByText(en.admin.renewals.urgencyBuckets.monthLensBadge);
    expect(badge.closest('[aria-hidden]')).not.toBeNull();
  });

  it('still exposes the aria-describedby hint (screen-reader channel) while a month lens is active', () => {
    const { container } = renderDimmed();
    const region = container.querySelector('[role="region"]') as HTMLElement;
    const hintId = region.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId!)?.textContent).toMatch(/month filter/i);
  });

  it('a paused tab is still clickable and exits the month lens (URL logic preserved)', () => {
    push.mockClear();
    renderDimmed();
    fireEvent.click(screen.getByText('T-30'));
    const url = push.mock.calls[0]![0] as string;
    expect(url).not.toContain('month=');
    expect(url).toContain('urgency=t-30');
    expect(push.mock.calls[0]![1]).toEqual({ scroll: false });
  });

  it('renders NO badge and NO aria-describedby when monthLensActive is absent', () => {
    const { container } = renderTabs('t-30');
    const region = container.querySelector('[role="region"]') as HTMLElement;
    expect(region.className).not.toMatch(/opacity-60/);
    expect(region.getAttribute('aria-describedby')).toBeNull();
    expect(
      screen.queryByText(en.admin.renewals.urgencyBuckets.monthLensBadge),
    ).toBeNull();
  });
});
