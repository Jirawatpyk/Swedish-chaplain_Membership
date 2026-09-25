// @vitest-environment jsdom
/**
 * #400 item 8 — the "Waiting on marketing" preset on the staff E-Blast queue.
 *
 * The nav's Broadcasts link opens `MARKETING_TURN_QUEUE_HREF` — the queue
 * filtered to exactly `MARKETING_TURN_STATUSES`, as repeated `status` params
 * the page already parses (the staff home's "waiting" card uses the same URL).
 * The filter bar names that view: a toggle, pressed exactly when the stage
 * filter IS that set, that selects the four stages and, off, returns to the
 * FR-010 default (which is unchanged: no params → `submitted`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { QueueFilters } from '@/components/broadcast/admin/queue-filters';
import { MARKETING_TURN_QUEUE_HREF } from '@/app/(staff)/admin/broadcasts/_lib/queue-view';
import { MARKETING_TURN_STATUSES } from '@/modules/broadcasts/domain/stage/whose-turn';
import { BROADCAST_STATUSES, type BroadcastStatus } from '@/modules/broadcasts/domain/value-objects/broadcast-status';

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
const LABEL = enMessages.admin.broadcasts.queue.filters.waitingOnMarketing;

function filters(
  { stageCounts = ZERO, approvalRoundEnabled = true }: {
    stageCounts?: Record<BroadcastStatus, number> | null;
    approvalRoundEnabled?: boolean;
  } = {},
) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QueueFilters memberOptions={[]} stageCounts={stageCounts} approvalRoundEnabled={approvalRoundEnabled} />
    </NextIntlClientProvider>
  );
}

const presetButton = () => screen.getByRole('button', { name: LABEL });
const lastUrl = () => new URL(nav.replaceMock.mock.calls.at(-1)![0] as string, 'http://x');

beforeEach(() => {
  vi.useRealTimers();
  nav.replaceMock.mockClear();
  nav.searchParams.current = new URLSearchParams();
});
afterEach(cleanup);

describe('the Waiting on marketing preset (#400 item 8)', () => {
  it('is pressed on the view the nav link opens — whatever order the stages arrive in', () => {
    nav.searchParams.current = new URL(MARKETING_TURN_QUEUE_HREF, 'http://x').searchParams;
    const { rerender } = render(filters());
    expect(presetButton()).toHaveAttribute('aria-pressed', 'true');

    nav.searchParams.current = new URLSearchParams([...MARKETING_TURN_STATUSES].reverse().map((s) => ['status', s]));
    rerender(filters());
    expect(presetButton()).toHaveAttribute('aria-pressed', 'true');
  });

  it.each([
    ['the FR-010 default (no params → submitted only)', ''],
    ['a subset of the four', 'status=submitted&status=in_design'],
    ['the four plus another stage', `${[...MARKETING_TURN_STATUSES, 'approved'].map((s) => `status=${s}`).join('&')}`],
    ['show all', 'status_all=1'],
  ])('is not pressed on %s', (_name, query) => {
    nav.searchParams.current = new URLSearchParams(query);
    render(filters());
    expect(presetButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('turning it on selects exactly the four marketing-turn stages (and leaves the Upcoming bound)', () => {
    nav.searchParams.current = new URLSearchParams('status=approved&sort=scheduled_for&from=now&memberId=m-1');
    render(filters());
    fireEvent.click(presetButton());
    const url = lastUrl();
    expect(url.pathname).toBe('/admin/broadcasts');
    expect(url.searchParams.getAll('status')).toEqual([...MARKETING_TURN_STATUSES]);
    expect(url.searchParams.has('sort')).toBe(false);
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.get('memberId')).toBe('m-1');
  });

  it('turning it off returns the stages to the FR-010 default', () => {
    nav.searchParams.current = new URL(MARKETING_TURN_QUEUE_HREF, 'http://x').searchParams;
    render(filters());
    fireEvent.click(presetButton());
    expect(lastUrl().searchParams.getAll('status')).toEqual([]);
    expect(lastUrl().search).toBe('');
  });
});

/**
 * #400 U2 — the toggle follows the nav badge's R18 rule. With the approval
 * round dark (flag off, no row in a round stage — prod today) the preset
 * would be `submitted` plus three stages that cannot hold rows, so it is not
 * offered at all.
 */
describe('the preset is offered only while the approval round is visible (#400 U2)', () => {
  const queryPreset = () => screen.queryByRole('button', { name: LABEL });

  it('flag off and no row in the round: no toggle', () => {
    render(filters({ approvalRoundEnabled: false }));
    expect(queryPreset()).toBeNull();
  });

  it('flag off but a row still in the round: the toggle is offered', () => {
    render(filters({ approvalRoundEnabled: false, stageCounts: { ...ZERO, awaiting_member_approval: 1 } }));
    expect(queryPreset()).not.toBeNull();
  });

  it('the stage counts are unavailable: the toggle is offered, like every chip (never hide a stage that may hold work)', () => {
    render(filters({ approvalRoundEnabled: false, stageCounts: null }));
    expect(queryPreset()).not.toBeNull();
  });

  it('a preset that arrived by URL keeps its (pressed) toggle, so it can be turned off', () => {
    nav.searchParams.current = new URL(MARKETING_TURN_QUEUE_HREF, 'http://x').searchParams;
    render(filters({ approvalRoundEnabled: false }));
    expect(presetButton()).toHaveAttribute('aria-pressed', 'true');
  });

  it('turning that preset off unmounts the toggle — focus goes to the first Stage checkbox, never <body>', () => {
    nav.searchParams.current = new URL(MARKETING_TURN_QUEUE_HREF, 'http://x').searchParams;
    const { rerender } = render(filters({ approvalRoundEnabled: false }));
    presetButton().focus();
    fireEvent.click(presetButton());
    // The navigation lands: back to the FR-010 default, where the round is not visible.
    nav.searchParams.current = new URLSearchParams();
    rerender(filters({ approvalRoundEnabled: false }));
    expect(queryPreset()).toBeNull();
    const firstStage = screen
      .getByRole('group', { name: /stage/i })
      .querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(document.activeElement).toBe(firstStage);
  });
});
