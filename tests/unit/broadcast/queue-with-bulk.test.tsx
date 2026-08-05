/**
 * Task 6 (2026-08-01-broadcast-review-queue-pr2) — `<QueueWithBulk>`
 * integration test.
 *
 * This is the wrapper that lifts row-selection OUT of `QueueTableClient`
 * and composes it with the fixed-bottom `QueueBulkActionBar` (Task 5) as
 * siblings — see the module docstring in `queue-with-bulk.tsx` for the
 * full contract. This test exercises the actual wiring end-to-end: ticking
 * a row checkbox in the (real) TanStack table must surface the toolbar
 * with the right count, and the toolbar's own Clear button must unmount
 * itself by driving the SAME selection back to empty.
 *
 * `vi.useRealTimers()` in `beforeEach` — shared test setup (`tests/setup.ts`)
 * installs fake timers globally, under which `@testing-library/user-event`
 * schedules its internal delays; `await user.click()` never resolves under
 * fake timers and the test dies on the 30s test timeout. Precedent:
 * `queue-table-client-a11y.test.tsx`, `queue-bulk-action-bar.test.tsx`.
 *
 * Base UI's `Checkbox` dispatches via `PointerEvent`, which jsdom does not
 * implement — minimal polyfill copied from `queue-table-client-a11y.test.tsx`
 * / `queue-card-list.test.tsx`.
 *
 * `next/navigation` is mocked — `QueueBulkActionBar` calls `router.refresh()`
 * after a fan-out, and `ReviewActions` (rendered per actionable row via the
 * `actions` column) mounts dialogs that call `useRouter()` unconditionally.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { QueueWithBulk } from '@/components/broadcast/admin/queue-with-bulk';
import type { EnrichedQueueRow } from '@/components/broadcast/admin/queue-table-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(cleanup);

function Provider({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  );
}

function makeRow(overrides: Partial<EnrichedQueueRow> = {}): EnrichedQueueRow {
  return {
    broadcastId: 'b1',
    subject: 'Q3 Newsletter',
    memberDisplayName: 'Acme Co',
    actorRoleLabel: null,
    segmentLabel: 'All members',
    recipientCount: 42,
    submittedAtFormatted: '1 Aug 2026, 07:00',
    ageBadge: null,
    statusBadgeVariant: 'secondary',
    statusBadgeLabel: 'Awaiting review',
    actionable: true,
    ...overrides,
  };
}

const LABELS = {
  submittedAt: 'Submitted',
  member: 'Member',
  subject: 'Subject',
  segment: 'Audience',
  recipientCount: 'Recipients',
  status: 'Status',
  actions: 'Actions',
  select: 'Select broadcast',
  tableAria: 'Broadcast review queue',
};

describe('<QueueWithBulk>', () => {
  it('lifts selection to the toolbar and clears both on Clear', async () => {
    const user = userEvent.setup();
    render(
      <Provider>
        <QueueWithBulk
          rows={[
            makeRow({ broadcastId: 'b1' }),
            makeRow({ broadcastId: 'b2' }),
          ]}
          readOnly={false}
          columnLabels={LABELS}
        />
      </Provider>,
    );

    // No toolbar before any selection.
    expect(screen.queryByRole('toolbar')).toBeNull();

    const rowChecks = within(
      screen.getByRole('table').querySelector('tbody')!,
    ).getAllByRole('checkbox');
    await user.click(rowChecks[0]!);

    const bar = await screen.findByRole('toolbar');
    expect(within(bar).getByText('1 selected')).toBeInTheDocument();

    // The desktop table's own checkbox reflects the SAME lifted state —
    // no forked selection between the table and the toolbar.
    expect(rowChecks[0]).toHaveAttribute('aria-checked', 'true');

    await user.click(within(bar).getByRole('button', { name: /clear/i }));

    // Selection cleared → bar unmounts AND the table's checkbox resets —
    // the parity guarantee this task's wiring must not break.
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(rowChecks[0]).toHaveAttribute('aria-checked', 'false');
  });

  it('never renders the toolbar for a read-only (manager) render', () => {
    render(
      <Provider>
        <QueueWithBulk
          rows={[makeRow({ broadcastId: 'b1' })]}
          readOnly
          columnLabels={LABELS}
        />
      </Provider>,
    );

    // No select column at all when read-only — nothing to click.
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
});

/**
 * Cross-PR hotfix (broadcast-queue-crosspr-hotfix, Task 1) —
 * stale-selection-mirror regression found by a holistic post-merge audit
 * that no single-PR review could see (PR1 built the announcer, PR2 lifted
 * selection into this wrapper, PR3 added the reselect-on-partial-failure
 * path; none of them exercised "a row drops out of `rows` while OTHER rows
 * stay selected, without any selection UI interaction").
 *
 * In production this happens via `router.refresh()`: the default queue view
 * filters to `status=['submitted']`, so approving/rejecting ONE selected row
 * individually (via its own per-row `ReviewActions`, not the bulk bar) drops
 * it out of the refreshed `rows` prop while the OTHER checked rows are still
 * `submitted`. This test simulates that with `rerender` — swapping the
 * `rows` prop directly — because driving it through the real per-row action
 * would just be re-testing `ReviewActions`' own fetch/refresh wiring, not
 * the selection-mirror bug.
 */
describe('<QueueWithBulk> — cross-PR hotfix: selection re-sync + prune on a data refresh', () => {
  it('re-syncs the toolbar count and prunes the dropped row so it does NOT resurrect checked if it reappears', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Provider>
        <QueueWithBulk
          rows={[
            makeRow({ broadcastId: 'a' }),
            makeRow({ broadcastId: 'b' }),
            makeRow({ broadcastId: 'c' }),
          ]}
          readOnly={false}
          columnLabels={LABELS}
        />
      </Provider>,
    );

    const getTbody = () => screen.getByRole('table').querySelector('tbody')!;
    let rowChecks = within(getTbody()).getAllByRole('checkbox');
    await user.click(rowChecks[0]!); // a
    await user.click(rowChecks[1]!); // b
    await user.click(rowChecks[2]!); // c

    const bar = await screen.findByRole('toolbar');
    expect(within(bar).getByText('3 selected')).toBeInTheDocument();

    // Simulate `router.refresh()` dropping row `b` out of the filtered
    // queue (e.g. it was individually approved/rejected) — NO selection
    // checkbox is touched here, only the `rows` prop changes.
    rerender(
      <Provider>
        <QueueWithBulk
          rows={[makeRow({ broadcastId: 'a' }), makeRow({ broadcastId: 'c' })]}
          readOnly={false}
          columnLabels={LABELS}
        />
      </Provider>,
    );

    // The mirror must re-sync to the two SURVIVING rows — not stay at 3
    // (the phantom-fan-out bug: a bulk-approve retry would otherwise POST
    // `/approve` for the now-absent `b` and 409).
    await waitFor(() => {
      expect(within(screen.getByRole('toolbar')).getByText('2 selected')).toBeInTheDocument();
    });

    rowChecks = within(getTbody()).getAllByRole('checkbox');
    expect(rowChecks).toHaveLength(2);
    expect(rowChecks[0]).toHaveAttribute('aria-checked', 'true'); // a
    expect(rowChecks[1]).toHaveAttribute('aria-checked', 'true'); // c

    // Prove the phantom is actually PRUNED from `rowSelection`, not merely
    // hidden because its row is absent: bring `b` back (e.g. the admin
    // navigates to a different filter and back) and confirm it reappears
    // UNCHECKED. A stale `rowSelection.b === true` left over from before the
    // prune would resurrect it checked here.
    rerender(
      <Provider>
        <QueueWithBulk
          rows={[
            makeRow({ broadcastId: 'a' }),
            makeRow({ broadcastId: 'b' }),
            makeRow({ broadcastId: 'c' }),
          ]}
          readOnly={false}
          columnLabels={LABELS}
        />
      </Provider>,
    );

    // `b` reappearing doesn't change the selection count (it comes back
    // unchecked) — settle on the same "2 selected" before reading
    // checkboxes, so the prune effect's state update from this rerender is
    // flushed inside `waitFor`'s `act()` wrapper rather than racing it.
    await waitFor(() => {
      expect(within(screen.getByRole('toolbar')).getByText('2 selected')).toBeInTheDocument();
    });

    rowChecks = within(getTbody()).getAllByRole('checkbox');
    expect(rowChecks).toHaveLength(3);
    expect(rowChecks[0]).toHaveAttribute('aria-checked', 'true'); // a
    expect(rowChecks[1]).toHaveAttribute('aria-checked', 'false'); // b — not resurrected
    expect(rowChecks[2]).toHaveAttribute('aria-checked', 'true'); // c
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Task 6 (2026-08-02-broadcast-review-queue-pr3) — failed-rows-stay retry.
 *
 * Before this task, a PARTIAL bulk-approve failure cleared the WHOLE
 * selection (`handlePartialFailure` → `handleClear`, see the pre-Task-6
 * comment this replaced in `queue-with-bulk.tsx`). This drives the real
 * fan-out through a stubbed `fetch` (b1 succeeds, b2 500s) and proves the
 * controlled re-select lands on ONLY the failed row, with the toolbar count
 * and the table's own checkboxes staying in lockstep — the exact desync the
 * PR2 implementer flagged as a STOP condition if the naive fix were used.
 */
describe('<QueueWithBulk> — Task 6 failed-rows-stay retry (2026-08-02-broadcast-review-queue-pr3)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/b2/')
          ? jsonResponse({ error: { code: 'boom' } }, 500)
          : jsonResponse({ ok: true }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps only the failed row selected after a partial bulk-approve failure — toolbar count and checkboxes agree, no desync', async () => {
    const user = userEvent.setup();
    render(
      <Provider>
        <QueueWithBulk
          rows={[
            makeRow({ broadcastId: 'b1' }),
            makeRow({ broadcastId: 'b2' }),
          ]}
          readOnly={false}
          columnLabels={LABELS}
        />
      </Provider>,
    );

    const tbody = screen.getByRole('table').querySelector('tbody')!;
    const rowChecksBefore = within(tbody).getAllByRole('checkbox');
    await user.click(rowChecksBefore[0]!);
    await user.click(rowChecksBefore[1]!);

    const bar = await screen.findByRole('toolbar');
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();

    // Task 4's confirm gate sits in front of the fan-out now — go through it.
    await user.click(within(bar).getByRole('button', { name: 'Approve selected' }));
    await user.click(
      await screen.findByRole('button', { name: /Approve & send now/ }),
    );

    // After the fan-out settles: b1 succeeded (drops out), b2 failed (stays)
    // — the toolbar count reflects exactly the surviving selection.
    await waitFor(() => {
      expect(within(bar).getByText('1 selected')).toBeInTheDocument();
    });

    // No desync: re-query the SAME checkboxes and confirm they match the
    // toolbar's count exactly — b1 unchecked, b2 still checked.
    const rowChecksAfter = within(tbody).getAllByRole('checkbox');
    expect(rowChecksAfter[0]).toHaveAttribute('aria-checked', 'false');
    expect(rowChecksAfter[1]).toHaveAttribute('aria-checked', 'true');

    // Retry re-opens a FRESH confirm dialog — switching to Schedule shows an
    // empty, unvalidated input, proving the min-lead re-check runs against
    // the CURRENT clock rather than carrying over stale state from the
    // aborted first attempt.
    await user.click(screen.getByRole('button', { name: 'Approve selected' }));
    await user.click(await screen.findByRole('radio', { name: /Schedule/ }));
    expect(
      screen.getByRole('button', { name: /Approve & schedule/ }),
    ).toBeDisabled();
  });
});
