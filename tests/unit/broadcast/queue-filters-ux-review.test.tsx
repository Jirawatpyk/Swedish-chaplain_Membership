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
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
      <QueueFilters timeZone="Asia/Bangkok" memberOptions={[]} stageCounts={ZERO} approvalRoundEnabled={approvalRoundEnabled} />
    </NextIntlClientProvider>
  );
}

const upcomingButton = () => screen.getByRole('button', { name: /upcoming sends/i });
const firstStageChip = () =>
  screen.getByRole('group', { name: /^stage$/i }).querySelector<HTMLButtonElement>('button[aria-pressed]')!;
const stageChip = (name: RegExp) =>
  within(screen.getByRole('group', { name: /^stage$/i })).getByRole('button', { name });
const queryStageChip = (name: RegExp) =>
  within(screen.getByRole('group', { name: /^stage$/i })).queryByRole('button', { name });

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

  it('the pressed state is AURA\'s selected chip, as a ticked stage; the unpressed one is not', () => {
    const { rerender } = render(filters());
    expect(upcomingButton()).toHaveAttribute('aria-pressed', 'false');
    expect(upcomingButton()).not.toHaveClass('is-selected');

    nav.searchParams.current = new URLSearchParams('status=approved&sort=scheduled_for&from=now');
    rerender(filters());
    expect(upcomingButton()).toHaveAttribute('aria-pressed', 'true');
    expect(upcomingButton()).toHaveClass('aura-tag', 'is-selected');
  });
});

describe('focus survives a control that unmounts under it (UX review LOW)', () => {
  it('unchecking a chip offered only because the URL named it moves focus to the first Stage chip', () => {
    // Flag off + zero rows: `member_approved` is offered ONLY because the URL names it.
    nav.searchParams.current = new URLSearchParams('status=member_approved');
    const { rerender } = render(filters(false));
    const chip = stageChip(/member approved/i);
    chip.focus();
    fireEvent.click(chip);
    // The navigation lands: the chip is no longer in the URL, so it unmounts.
    nav.searchParams.current = new URLSearchParams('status_all=1');
    rerender(filters(false));
    expect(queryStageChip(/member approved/i)).toBeNull();
    expect(document.activeElement).toBe(firstStageChip());
  });

  it('Reset unmounting itself moves focus to the first Stage chip', () => {
    nav.searchParams.current = new URLSearchParams('status=sent');
    const { rerender } = render(filters());
    const reset = screen.getByRole('button', { name: /reset/i });
    reset.focus();
    fireEvent.click(reset);
    nav.searchParams.current = new URLSearchParams();
    rerender(filters());
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
    expect(document.activeElement).toBe(firstStageChip());
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

describe('Reset matches its neighbours (UX review LOW)', () => {
  it('Reset is an AURA button with the same 44px touch height as the chips beside it', () => {
    nav.searchParams.current = new URLSearchParams('status=sent');
    render(filters());
    const reset = screen.getByRole('button', { name: /reset/i });
    expect(reset).toHaveClass('aura-btn', 'aura-btn--touch');
  });
});

/**
 * FR-030 — the stage chip counts stay per stage for the WHOLE tenant (they are
 * the stage backlog FR-025 asks for, and R18 offers a chip by them). When a
 * filter they cannot see is on — member, date range, the Upcoming bound — the
 * Stage group says so in its accessible description, and on screen, instead of
 * letting "70 E-Blasts" sit beside a list of five.
 */
describe('chip counts under a filter they do not see (FR-030)', () => {
  const stageGroup = () => screen.getByRole('group', { name: /^stage$/i });

  it.each([['fromDate=2026-09-01'], ['toDate=2026-09-30'], ['memberId=m-1'], ['status=approved&sort=scheduled_for&from=now']])(
    '%s → the Stage group is described as counting every E-Blast',
    (query) => {
      nav.searchParams.current = new URLSearchParams(query);
      render(filters());
      expect(stageGroup()).toHaveAccessibleDescription(/every e-blast in each stage/i);
    },
  );

  it('no such filter → no description (the counts ARE the view)', () => {
    nav.searchParams.current = new URLSearchParams('status=submitted');
    render(filters());
    expect(stageGroup()).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText(/every e-blast in each stage/i)).toBeNull();
  });
});

/**
 * T086a V4 (PR-1's U14) — the chip once wrapped a 16 px checkbox in a 44 px
 * pill and had to move the focus ring onto the pill. Spec 122 US12b — the chip
 * is an AURA toggle (a native button with `aria-pressed`), so the control that
 * takes focus IS the pill and wears AURA's own ring: one focusable control,
 * one ring.
 */
describe('chip focus ring (T086a V4)', () => {
  it('each stage chip is one focusable native button with aria-pressed', () => {
    render(filters());
    const chip = firstStageChip();
    expect(chip.tagName).toBe('BUTTON');
    expect(chip).toHaveAttribute('aria-pressed');
    expect(chip).toHaveClass('aura-tag');
    expect(chip.querySelector('input, button')).toBeNull();
  });
});

/**
 * T086a follow-on — the dates filter on the SUBMIT date. Parity comments
 * (19 Oct): one AURA "Submitted" range, as audit and change requests, in
 * place of two native date boxes (an en-US browser showed mm/dd/yyyy).
 */
describe('the "Submitted" date range (parity, 19 Oct)', () => {
  it('is one AURA date range named for the submitted date, with no native date boxes', () => {
    render(filters());
    expect(screen.getByRole('button', { name: 'Submitted: Any time' })).toBeInTheDocument();
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });

  it('shows the range from the URL, and "Any time" drops both days and the cursor', () => {
    nav.searchParams.current = new URLSearchParams('memberId=m-1&fromDate=2026-09-01&toDate=2026-09-10&cursor=abc');
    render(filters());
    const range = screen.getByRole('button', { name: /^Submitted: 1\s?–\s?10 Sept 2026$/ });
    fireEvent.click(range);
    fireEvent.click(screen.getByRole('button', { name: 'Any time' }));
    expect(nav.replaceMock).toHaveBeenLastCalledWith('/admin/broadcasts?memberId=m-1', { scroll: false });
  });
});

/**
 * Parity comments (19 Oct) — "group it neatly": each chip group is named by a
 * caption on screen, and the two presets are their own "Quick views" group,
 * before the member and date fields instead of after them.
 */
describe('chip groups with visible captions (parity, 19 Oct)', () => {
  it.each([['In review'], ['Closed'], ['Quick views']])('the %s group is named by its visible caption', (name) => {
    render(filters(true));
    const group = screen.getByRole('group', { name });
    const captionId = group.getAttribute('aria-labelledby');
    expect(captionId).toBeTruthy();
    expect(document.getElementById(captionId!)).toHaveTextContent(name);
    expect(document.getElementById(captionId!)).not.toHaveClass('sr-only');
  });

  it('the presets sit in Quick views, before the member and date fields', () => {
    render(filters(true));
    const quick = screen.getByRole('group', { name: 'Quick views' });
    expect(within(quick).getByRole('button', { name: /upcoming sends/i })).toBeInTheDocument();
    expect(within(quick).getByRole('button', { name: /waiting on marketing/i })).toBeInTheDocument();
    const member = screen.getByRole('combobox', { name: /member/i });
    expect(quick.compareDocumentPosition(member) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

/**
 * Spec 122 US12b — the queue's filters follow the global filter pattern: an
 * AURA `FilterBar` whose controls fold into a "Filters (n)" sheet on a phone.
 * The bar shows no chips of its own, so it is told how many filters are on.
 */
describe('the global filter pattern (spec 122 US12b)', () => {
  it('is an AURA FilterBar named for the queue filters, folding below 640 px', () => {
    render(filters());
    const bar = screen.getByRole('region', { name: 'Broadcast queue filters' });
    expect(bar).toHaveClass('aura-filterbar');
    expect(within(bar).getByRole('button', { name: /filters/i })).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('the Filters button counts the filters that are on (a stage, a member, each date)', () => {
    nav.searchParams.current = new URLSearchParams('status=sent&memberId=m-1&fromDate=2026-09-01');
    render(filters());
    const bar = screen.getByRole('region', { name: 'Broadcast queue filters' });
    // (Reset is "Reset filters" too, so the sheet button is found by its popup.)
    expect(bar.querySelector('button[aria-haspopup="dialog"]')).toHaveTextContent('Filters (3)');
  });

  // US12b UX review M2 — the default view is one stage, and a phone user must
  // see that the cards are filtered (board `Admin-broadcasts-mobile`).
  it('the default view counts its stage, so the phone button reads "Filters (1)"', () => {
    render(filters());
    const bar = screen.getByRole('region', { name: 'Broadcast queue filters' });
    expect(bar.querySelector('button[aria-haspopup="dialog"]')).toHaveTextContent('Filters (1)');
  });

  // US12b UX review M1 / L8 — from 640 px the whole stage name and its count
  // show (AURA caps a Tag's text at 24ch outside its own chip row), and AURA's
  // own tip is the only tooltip on a cut chip.
  it('a stage chip lifts AURA\'s text cap from sm up and carries no title tooltip', () => {
    render(filters(true));
    const chip = stageChip(/changes requested/i);
    expect(chip).toHaveClass('sm:[&_.aura-tag\\_\\_text]:max-w-none');
    expect(chip).not.toHaveAttribute('title');
  });
});
