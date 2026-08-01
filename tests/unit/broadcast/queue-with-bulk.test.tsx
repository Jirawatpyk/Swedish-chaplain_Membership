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
import { render, screen, within, cleanup } from '@testing-library/react';
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
