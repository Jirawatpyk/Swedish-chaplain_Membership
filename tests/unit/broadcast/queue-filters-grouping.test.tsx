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
import {
  BROADCAST_STATUSES,
  RETIRED_BROADCAST_STATUSES,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';

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

  /**
   * 10 → 8 (108 Phase 9 review S44). `partially_sent` and
   * `partial_delivery_accepted` are registered in `RETIRED_BROADCAST_STATUSES`:
   * their producing use cases were deleted with the batch path, so filtering on
   * either can only ever return zero rows — and zero rows reads as "it never
   * happened", not as "this state can no longer be produced".
   *
   * They remain in `BROADCAST_STATUSES` and in `status-badge-mapping`, so a
   * historical row still parses and still renders its badge. What is withheld is
   * the CHIP, and only the chip.
   *
   * Derived rather than hard-coded, so the next status added or retired updates
   * this assertion by itself — the count is what went stale here, and it is the
   * only thing in the file that could.
   */
  it('renders one checkbox per non-retired status across the two groups', () => {
    render(
      <Provider>
        <QueueFilters memberOptions={[]} />
      </Provider>,
    );

    const offered = BROADCAST_STATUSES.filter(
      (s) => !(RETIRED_BROADCAST_STATUSES as readonly string[]).includes(s),
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(offered.length);

    // Positive controls: the count alone passes if the strip renders the wrong
    // eight, and it also passes if a live status were retired by mistake.
    expect(offered).toHaveLength(8);
    expect(offered).toContain('sent');
    expect(offered).toContain('failed_to_dispatch');
    expect(offered).not.toContain('partially_sent');
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
