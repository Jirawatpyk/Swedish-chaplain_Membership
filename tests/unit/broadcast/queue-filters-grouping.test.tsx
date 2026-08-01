/**
 * Task 7 (2026-08-01-broadcast-review-queue-pr2) — status chip grouping.
 *
 * WS-G: the flat 10-chip status strip in `<QueueFilters>` is split into two
 * `role="group"` clusters — "in review" (submitted/approved/sending/draft)
 * and "terminal" (the remaining 6 statuses, derived by filtering
 * `BROADCAST_STATUSES` so a newly-added status can't silently vanish from
 * both groups) — so admins can visually separate "still needs attention"
 * from "already resolved" instead of parsing a flat row. Also guards the
 * Reset control's position: it used to carry `ml-auto`, which shoved it to
 * the far right of the WHOLE filter row instead of sitting next to the
 * chips it resets (the renewals month-lens lesson).
 *
 * `next/navigation` is mocked per the F3 `directory-filters` pattern
 * (`tests/unit/members/presentation/directory-filters-search-focus.test.tsx`)
 * since `QueueFilters` is a client component driven entirely by URL state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { QueueFilters } from '@/components/broadcast/admin/queue-filters';

const nav = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replaceMock }),
  usePathname: () => '/admin/broadcasts/queue',
  useSearchParams: () => nav.searchParams.current,
}));

function Provider({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  nav.replaceMock.mockClear();
  // Non-empty status param so `hasAnyFilter` is true and the Reset button
  // actually renders (it's conditionally mounted only when a filter is set).
  nav.searchParams.current = new URLSearchParams('status=submitted');
});

describe('<QueueFilters> — status chip grouping + Reset placement', () => {
  it('splits the status chips into an in-review group and a terminal group', () => {
    render(
      <Provider>
        <QueueFilters memberOptions={[]} />
      </Provider>,
    );

    // M-2 (PR2 whole-branch review) — the terminal group's label changed
    // from "Completed" to "Closed" (a group that holds rejected/cancelled/
    // failed_to_dispatch/partially_sent read as "success" under the old
    // label). Matches BOTH groups' actual aria-label text
    // (`statusGroup.inReview` / `statusGroup.terminal` in en.json) — not the
    // internal `terminal` key name, which is never rendered.
    const groups = screen.getAllByRole('group', {
      name: /in review|closed/i,
    });
    expect(groups.length).toBeGreaterThanOrEqual(2);
  });

  it('still renders all 10 statuses as checkboxes across the two groups', () => {
    render(
      <Provider>
        <QueueFilters memberOptions={[]} />
      </Provider>,
    );

    expect(screen.getAllByRole('checkbox')).toHaveLength(10);
  });

  it('keeps the Reset button adjacent to the chip strip, not pushed to the row edge', () => {
    render(
      <Provider>
        <QueueFilters memberOptions={[]} />
      </Provider>,
    );

    const reset = screen.getByRole('button', { name: /reset/i });
    expect(reset.className).not.toMatch(/\bml-auto\b/);
  });
});
