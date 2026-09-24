/**
 * F119 dashboard UX review (2026-09-24) — the filter bar's behaviour fixes.
 *
 *   - M3: turning the Upcoming sends preset OFF removes only what the preset
 *     added (`sort`, `from`, `status`); the member and date filters the user
 *     chose stay. It used to call Reset and drop them too.
 *   - H5: the preset's pressed state is visible — the chip's checked style and
 *     a check icon — not an `outline` → `secondary` swap measured at 1.09:1.
 *   - LOW (focus): a control that unmounts under the keyboard user — a chip
 *     offered only because the URL named it, or Reset once nothing is left to
 *     reset — hands focus to the first Stage checkbox instead of `<body>`.
 *
 * `next/navigation` is mocked per `queue-filters-flag-visibility.test.tsx`;
 * a URL change is modelled as a new `searchParams` + a rerender.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { QueueFilters } from '@/components/broadcast/admin/queue-filters';
import {
  BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';

const nav = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replaceMock }),
  usePathname: () => '/admin/broadcasts',
  useSearchParams: () => nav.searchParams.current,
}));

const ZERO = Object.fromEntries(BROADCAST_STATUSES.map((s) => [s, 0])) as Record<BroadcastStatus, number>;

function filters(approvalRoundEnabled = false) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QueueFilters memberOptions={[]} stageCounts={ZERO} approvalRoundEnabled={approvalRoundEnabled} />
    </NextIntlClientProvider>
  );
}

const upcomingButton = () => screen.getByRole('button', { name: /upcoming sends/i });
const firstStageCheckbox = () =>
  screen.getByRole('group', { name: /stage/i }).querySelector<HTMLInputElement>('input[type="checkbox"]')!;

beforeEach(() => {
  vi.useRealTimers();
  nav.replaceMock.mockClear();
  nav.searchParams.current = new URLSearchParams();
});
afterEach(cleanup);

describe('Upcoming sends preset (UX review M3, H5)', () => {
  it('turning it off drops sort, from and status only — the member and date filters stay', () => {
    nav.searchParams.current = new URLSearchParams(
      'status=approved&sort=scheduled_for&from=now&memberId=m-1&fromDate=2026-09-01',
    );
    render(filters());
    fireEvent.click(upcomingButton());
    expect(nav.replaceMock).toHaveBeenCalledTimes(1);
    const url = new URL(nav.replaceMock.mock.calls[0]![0] as string, 'http://x');
    expect(url.pathname).toBe('/admin/broadcasts');
    expect(url.searchParams.get('memberId')).toBe('m-1');
    expect(url.searchParams.get('fromDate')).toBe('2026-09-01');
    expect(url.searchParams.has('sort')).toBe(false);
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.getAll('status')).toEqual([]);
  });

  it('the pressed state carries the chip\'s checked style and a check icon; the unpressed one neither', () => {
    const { rerender } = render(filters());
    expect(upcomingButton()).toHaveAttribute('aria-pressed', 'false');
    expect(upcomingButton().className).not.toContain('border-primary/40');
    expect(upcomingButton().querySelector('[data-icon="pressed-check"]')).toBeNull();

    nav.searchParams.current = new URLSearchParams('status=approved&sort=scheduled_for&from=now');
    rerender(filters());
    expect(upcomingButton()).toHaveAttribute('aria-pressed', 'true');
    expect(upcomingButton().className).toContain('bg-primary/10');
    expect(upcomingButton().className).toContain('border-primary/40');
    expect(upcomingButton().querySelector('[data-icon="pressed-check"]')).not.toBeNull();
  });
});

describe('focus survives a control that unmounts under it (UX review LOW)', () => {
  it('unchecking a chip offered only because the URL named it moves focus to the first Stage checkbox', () => {
    // Flag off + zero rows: `member_approved` is offered ONLY because the URL names it.
    nav.searchParams.current = new URLSearchParams('status=member_approved');
    const { rerender } = render(filters(false));
    const chip = screen.getByRole('checkbox', { name: /member approved/i });
    chip.focus();
    fireEvent.click(chip);
    // The navigation lands: the chip is no longer in the URL, so it unmounts.
    nav.searchParams.current = new URLSearchParams('status_all=1');
    rerender(filters(false));
    expect(screen.queryByRole('checkbox', { name: /member approved/i })).toBeNull();
    expect(document.activeElement).toBe(firstStageCheckbox());
  });

  it('Reset unmounting itself moves focus to the first Stage checkbox', () => {
    nav.searchParams.current = new URLSearchParams('status=sent');
    const { rerender } = render(filters());
    const reset = screen.getByRole('button', { name: /reset/i });
    reset.focus();
    fireEvent.click(reset);
    nav.searchParams.current = new URLSearchParams();
    rerender(filters());
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
    expect(document.activeElement).toBe(firstStageCheckbox());
  });

  it('a URL change the user did not start from a vanishing control leaves focus alone', () => {
    nav.searchParams.current = new URLSearchParams('status=sent');
    const { rerender } = render(filters());
    // Focus is on the page, not on a filter control (e.g. a click on a row).
    (document.activeElement as HTMLElement | null)?.blur();
    nav.searchParams.current = new URLSearchParams();
    rerender(filters());
    expect(document.activeElement).toBe(document.body);
  });
});

describe('Reset matches its h-9 neighbours (UX review LOW)', () => {
  it('Reset is the default (h-9) size, not sm (h-7)', () => {
    nav.searchParams.current = new URLSearchParams('status=sent');
    render(filters());
    const reset = screen.getByRole('button', { name: /reset/i });
    expect(reset.className).toContain('h-9');
    expect(reset.className).not.toContain('h-7');
  });
});
