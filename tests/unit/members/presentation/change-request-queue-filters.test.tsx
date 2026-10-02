/**
 * F114 US4 — `<ChangeRequestQueueFilters>` (the /admin/change-requests filter bar).
 *
 * The filter pattern (spec 122, docs/aura-adoption.md § Filters): one AURA
 * FilterBar row — Status, then Outcome only under Decided, then one
 * "Submitted" date range — that filters as you pick (`router.replace`,
 * scroll kept, never the cursor). Every non-default value is a removable chip
 * in the bar, the member / submitter scoping included, so the bar's own
 * "Clear filters" appears; the result count sits at the end of the row. The
 * URL parameters are the ones the page always read (`state`, `outcome`,
 * `from`, `to` inclusive, `memberId`, `submitter`).
 *
 * `next/navigation` is mocked per `queue-filters-grouping.test.tsx`. AURA's
 * FilterSelect keeps a native `<select>` named by its label, so the tests
 * pick an option by changing it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ChangeRequestQueueFilters } from '@/app/(staff)/admin/change-requests/_components/queue-filters';

const nav = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replaceMock, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/change-requests',
  useSearchParams: () => nav.searchParams.current,
}));

const F = enMessages.admin.changeRequests.filters;
const R = enMessages.admin.changeRequests.review;
const MEMBER = '11111111-1111-4111-8111-111111111111';
const SUBMITTER = '22222222-2222-4222-8222-222222222222';

interface BarProps {
  readonly resultCount?: number;
  readonly hasMore?: boolean;
  readonly memberCompany?: string | null;
}

function renderBar(query = '', props: BarProps = {}) {
  nav.searchParams.current = new URLSearchParams(query);
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ChangeRequestQueueFilters
        resultCount={props.resultCount ?? 2}
        hasMore={props.hasMore ?? false}
        timeZone="Asia/Bangkok"
        memberCompany={props.memberCompany ?? null}
      />
    </NextIntlClientProvider>,
  );
}

const region = () => screen.getByRole('region', { name: F.label });
const pick = (label: string, value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } });
const lastUrl = () => nav.replaceMock.mock.calls.at(-1);

beforeEach(() => {
  nav.replaceMock.mockClear();
  // 15 Sep 2026, midday in Bangkok — the presets count back from this day.
  vi.setSystemTime(new Date('2026-09-15T05:00:00Z'));
});

describe('<ChangeRequestQueueFilters> — the filter pattern', () => {
  it('is one FilterBar row: Status on Pending, a "Submitted" range on Any time; no Apply, no form, no Clear on the default view', () => {
    renderBar();
    const bar = region();
    expect(within(bar).getByRole('combobox', { name: F.state })).toHaveValue('pending');
    expect(within(bar).queryByRole('combobox', { name: F.outcome })).toBeNull();
    expect(within(bar).getByRole('button', { name: `${F.submitted}: Any time` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^apply$/i })).toBeNull();
    expect(document.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button', { name: F.clear })).toBeNull();
    expect(screen.getByTestId('queue-filters')).toContainElement(bar);
  });

  it('a status pick writes the URL at once, keeping the member / submitter scoping and dropping the cursor', () => {
    renderBar(`memberId=${MEMBER}&submitter=${SUBMITTER}&cursor=abc`);
    pick(F.state, 'decided');
    expect(lastUrl()).toEqual([
      `/admin/change-requests?state=decided&memberId=${MEMBER}&submitter=${SUBMITTER}`,
      { scroll: false },
    ]);
  });

  it('the pending default writes no state param', () => {
    renderBar('state=decided');
    pick(F.state, 'pending');
    expect(lastUrl()).toEqual(['/admin/change-requests', { scroll: false }]);
  });

  it('Outcome sits right after Status, only under Decided; leaving Decided drops the outcome', () => {
    renderBar('state=decided&outcome=approved');
    const boxes = within(region()).getAllByRole('combobox');
    expect(boxes).toEqual([
      within(region()).getByRole('combobox', { name: F.state }),
      within(region()).getByRole('combobox', { name: F.outcome }),
    ]);
    expect(boxes[1]).toHaveValue('approved');
    pick(F.outcome, 'rejected');
    expect(lastUrl()?.[0]).toBe('/admin/change-requests?state=decided&outcome=rejected');
    pick(F.state, 'withdrawn');
    expect(lastUrl()?.[0]).toBe('/admin/change-requests?state=withdrawn');
  });

  it('a date preset writes the whole range in the tenant day, the end inclusive', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: `${F.submitted}: Any time` }));
    fireEvent.click(screen.getByRole('button', { name: F.presets.last7 }));
    expect(lastUrl()).toEqual(['/admin/change-requests?from=2026-09-09&to=2026-09-15', { scroll: false }]);
  });

  it('every non-default value is a chip in the bar; removing the member chip keeps the other filters', () => {
    renderBar(`state=decided&outcome=approved&memberId=${MEMBER}&submitter=${SUBMITTER}&from=2026-09-01&to=2026-09-10`, {
      memberCompany: 'Siam Nordic Trading',
    });
    const chips = document.querySelector('.aura-filterbar__chips');
    expect(chips).toHaveTextContent(`${F.state}: ${R.state.decided}`);
    expect(chips).toHaveTextContent(`${F.outcome}: ${R.outcome.approved}`);
    expect(chips).toHaveTextContent(`${F.member}: Siam Nordic Trading`);
    expect(chips).toHaveTextContent(F.submitterChip);
    expect(chips).toHaveTextContent(`${F.submitted}: Sep 1, 2026 – Sep 10, 2026`);
    fireEvent.click(screen.getByRole('button', { name: `Remove filter: ${F.member}: Siam Nordic Trading` }));
    expect(lastUrl()?.[0]).toBe(
      `/admin/change-requests?state=decided&outcome=approved&submitter=${SUBMITTER}&from=2026-09-01&to=2026-09-10`,
    );
  });

  it('Clear filters drops every param', () => {
    renderBar(`state=withdrawn&submitter=${SUBMITTER}`);
    fireEvent.click(screen.getByRole('button', { name: F.clear }));
    expect(lastUrl()).toEqual(['/admin/change-requests', { scroll: false }]);
  });

  it('a value the page would drop is no filter: no chip, no Clear (2026-02-30 is not a calendar day)', () => {
    renderBar('state=bogus&outcome=approved&from=2026-02-30');
    expect(document.querySelector('.aura-filterbar__chips')).toBeNull();
    expect(screen.getByRole('button', { name: `${F.submitted}: Any time` })).toBeInTheDocument();
  });

  it('the result count sits at the end of the row, announced politely, with the next-page wording when there is more', () => {
    const { unmount } = renderBar('', { resultCount: 2 });
    const count = screen.getByTestId('queue-result-count');
    expect(count).toHaveTextContent('Showing 2 requests');
    expect(count.closest('[aria-live="polite"]')).not.toBeNull();
    unmount();
    renderBar('', { resultCount: 50, hasMore: true });
    expect(screen.getByTestId('queue-result-count')).toHaveTextContent('Showing the first 50 requests');
  });
});
