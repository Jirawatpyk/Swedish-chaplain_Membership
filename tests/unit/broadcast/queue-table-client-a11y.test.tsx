/**
 * Task 5 (2026-08-01-broadcast-review-queue-pr1) — bulk-selection bar a11y:
 * a PERMANENTLY-MOUNTED `role="status" aria-live="polite"` announcer for
 * the selected count, `indeterminate` (aria-checked="mixed") on the header
 * select-all checkbox when some-but-not-all actionable rows are selected,
 * and a 24px minimum touch target on every select checkbox (WCAG 2.2
 * SC 2.5.8).
 *
 * Round-2 review Fix 1 — the announcer must stay mounted across the
 * 0-selected ↔ 1-selected transition. A live region that is INSERTED into
 * the DOM already containing its text (e.g. conditionally rendered only
 * while `selectedIds.length > 0`) is not reliably announced by NVDA/JAWS —
 * only text MUTATIONS on an already-mounted region are. So this asserts
 * the region exists even with 0 selected (empty text) and gains the count
 * text after a row is selected — the exact 0→1 transition the feature
 * exists to announce.
 *
 * `QueueTableClient` now translates its own `bulk.*` strings via
 * `useTranslations` (Task 1 made `bulk.selected` an ICU-plural key), so this
 * renders under a real `NextIntlClientProvider` backed by canonical
 * `en.json` — an echo/mock translator would hide an ICU wiring regression.
 *
 * `QueueTableClient` calls `useRouter()` (for `router.refresh()` after a
 * bulk-approve action) — established idiom:
 * tests/unit/app/admin/renewals/tier-upgrade-queue.test.tsx:21-23.
 */
import { describe, expect, it, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  QueueTableClient,
  type EnrichedQueueRow,
} from '@/components/broadcast/admin/queue-table-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Base UI Checkbox dispatches via `PointerEvent`, which jsdom does not
// implement. Established idiom:
// tests/unit/members/presentation/members-table-selection.test.tsx:18-30.
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

const base: EnrichedQueueRow = {
  broadcastId: 'b1',
  subject: 'Hi',
  memberDisplayName: 'Acme',
  actorRoleLabel: null,
  segmentLabel: 'All members',
  recipientCount: 5,
  submittedAtFormatted: '1 Aug 2026, 07:00',
  ageBadge: null,
  statusBadgeVariant: 'secondary',
  statusBadgeLabel: 'Submitted',
  actionable: true,
};
const rows = [base, { ...base, broadcastId: 'b2', subject: 'Hi2' }];
// columnLabels now omits the bulk.* strings (client translates them):
const columnLabels = {
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

function renderTable() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QueueTableClient rows={rows} columnLabels={columnLabels} />
    </NextIntlClientProvider>,
  );
}

// Shared vitest setup installs fake timers; @testing-library/user-event
// schedules its internal delays on them, so `await user.click()` never
// resolves and every test dies on the 30s test timeout (not a `waitFor`
// timeout). Precedent: reference_component_test_harness_fake_timers memory.
beforeEach(() => {
  vi.useRealTimers();
});
afterEach(cleanup);

// The header select-all checkbox and every per-row checkbox share the same
// accessible name ("Select broadcast" — pre-existing, out of Task 5 scope),
// so `getAllByRole('checkbox', {name: ...})` returns [header, row1, row2] in
// DOM order (<thead> precedes <tbody>). Scope to `tbody` to reliably click a
// ROW checkbox rather than the select-all header.
function getRowCheckboxes(container: HTMLElement) {
  const tbody = container.querySelector('tbody');
  if (!tbody) throw new Error('tbody not found');
  return within(tbody).getAllByRole('checkbox', { name: /select broadcast/i });
}

describe('QueueTableClient a11y + ICU', () => {
  it('the selected-count announcer is permanently mounted and announces the 0→1 transition via ICU', async () => {
    const user = userEvent.setup();
    const { container } = renderTable();

    // Permanently-mounted regardless of selection state (Round-2 review
    // Fix 1) — must exist BEFORE any row is clicked, with empty text.
    const announcer = container.querySelector('[role="status"][aria-live="polite"]');
    expect(announcer).not.toBeNull();
    expect(announcer).toHaveAttribute('aria-atomic', 'true');
    expect(announcer).toHaveTextContent('');

    const [rowCheckbox] = getRowCheckboxes(container);
    await user.click(rowCheckbox!);

    // Same node, now carrying the ICU-pluralised count — a text MUTATION on
    // an already-mounted live region, which SR/AT reliably announce.
    expect(container.querySelector('[role="status"][aria-live="polite"]')).toBe(announcer);
    expect(announcer).toHaveTextContent(/1 selected/);
  });

  it('the header select-all checkbox exposes an indeterminate (mixed) state', async () => {
    const user = userEvent.setup();
    const { container } = renderTable();
    const [rowCheckbox] = getRowCheckboxes(container);
    await user.click(rowCheckbox!); // 1 of 2 selected → mixed
    // shadcn Checkbox indeterminate → aria-checked="mixed" on the header control
    const mixed = container.querySelector('[aria-checked="mixed"]');
    expect(mixed).not.toBeNull();
  });

  it('checkbox targets meet the 24px minimum — header AND row', () => {
    const { container } = renderTable();
    const headerCb = container.querySelector('thead [role="checkbox"], thead input[type="checkbox"]');
    expect(headerCb?.className ?? '').toMatch(/min-h-\[24px\]/);
    expect(headerCb?.className ?? '').toMatch(/min-w-\[24px\]/);

    const [rowCb] = getRowCheckboxes(container);
    expect(rowCb?.className ?? '').toMatch(/min-h-\[24px\]/);
    expect(rowCb?.className ?? '').toMatch(/min-w-\[24px\]/);
  });
});
