/**
 * Task 11 — `<PipelineTable>` month-lens empty-state unit tests.
 *
 * Only exercises the empty-rows branch (`rows={[]}`) since that is
 * the only path touched by the `monthLabel` prop — non-empty rows
 * render `RowActions` (router + toast wiring) which is exercised
 * elsewhere and is unaffected by this change.
 *
 * Task 1 (item ②) adds a non-empty-row suite below pinning the
 * visible "Send reminder" row button (promoted out of the ⋯ menu).
 *
 * Task 1 review-fix suite (below) pins three review findings:
 *   - the visible button stays at `h-9` (app's text-button convention;
 *     44px is reserved for the icon-only ⋯ trigger — see the source
 *     comment for the full rationale)
 *   - `aria-busy` + a motion-safe spinner while the request is pending
 *   - `finalFocus` threading: after "Mark contacted" opens the shared
 *     `OutreachDialog` and it is closed, focus returns to the row's own
 *     ⋯ trigger (which survives the menu closing) instead of dropping to
 *     `<body>` (the default-focus-restore bug this fix closes).
 *
 * `@/components/ui/dropdown-menu` is mocked to plain-HTML stand-ins for
 * the finalFocus suite — same pattern as
 * `auto-renewal-queue-actions.test.tsx` / `invoice-more-menu.test.tsx`
 * (Base UI Menu only renders its Popup while open + models portal/pointer
 * positioning jsdom does not support). `@/components/ui/dialog` is
 * DELIBERATELY left real: `OutreachDialog`'s `initialFocus`/`finalFocus`
 * are unconditional (no RAF-racing), which
 * `auto-renewal-queue-actions.test.tsx`'s header comment documents as the
 * jsdom-reliable shape for Base UI's portal focus management.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { PipelineTable } from '@/app/(staff)/admin/renewals/_components/pipeline-table';
import en from '@/i18n/messages/en.json';
import type { PipelineRow } from '@/modules/renewals/client';

// `refresh` is required too: `OutreachDialog`'s onConfirm (exercised by
// the review-fix-#5 finalFocus suite below) calls `router.refresh()` on
// a successful "Record outreach" submit.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// Simulate Base UI's React-19 render-prop contract: DropdownMenuTrigger
// passes its OWN ref inside the render callback's `props`. Plain-HTML
// stand-in — Base UI Menu only renders its Popup while open + models
// portal/pointer positioning jsdom does not support.
const { baseUiTriggerRef } = vi.hoisted(() => ({ baseUiTriggerRef: vi.fn() }));

vi.mock('@/components/ui/dropdown-menu', () => {
  function DropdownMenu({ children }: { children?: React.ReactNode }) {
    return <div data-testid="menu-root">{children}</div>;
  }
  function DropdownMenuTrigger({
    render: renderProp,
  }: {
    render?: (props: Record<string, unknown>) => React.ReactNode;
  }) {
    return <>{renderProp ? renderProp({ ref: baseUiTriggerRef }) : null}</>;
  }
  function DropdownMenuContent({ children }: { children?: React.ReactNode }) {
    return <div role="menu">{children}</div>;
  }
  function DropdownMenuItem({
    children,
    onClick,
    render: renderProp,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    render?: (props: Record<string, unknown>) => React.ReactNode;
  }) {
    if (renderProp) return <>{renderProp({ role: 'menuitem' })}</>;
    return (
      <button type="button" role="menuitem" onClick={onClick}>
        {children}
      </button>
    );
  }
  return { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem };
});

const EMPTY_ROWS: ReadonlyArray<PipelineRow> = [];

describe('<PipelineTable> empty state', () => {
  it('renders the month-aware empty copy when monthLabel is set', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} monthLabel="December 2026" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('No members renew in December 2026.')).toBeDefined();
  });

  it('renders the default bucket empty copy when monthLabel is absent', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('No members in this bucket.')).toBeDefined();
    expect(screen.getByText(/Switch to another urgency tab/)).toBeDefined();
  });

  // Deferred fix-wave-2 #4 — dedicated overdue/later empty copy. The bug
  // being pinned: the pre-fix code composed the bucket label into the
  // generic "No members renew in {month}." frame, yielding
  // "No members renew in Overdue." / a doubled "…or later or later".
  it('renders dedicated overdue empty copy when monthKind="overdue"', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} monthKind="overdue" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('No overdue renewals.')).toBeDefined();
  });

  it('renders dedicated later empty copy with a SINGLE "or later" when monthKind="later"', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable
          rows={EMPTY_ROWS}
          monthKind="later"
          monthLabel="August 2028"
        />
      </NextIntlClientProvider>,
    );
    // Exact string — proves the copy is NOT doubled
    // ("…August 2028 or later or later").
    expect(
      screen.getByText('No members renew August 2028 or later.'),
    ).toBeDefined();
    expect(screen.queryByText(/or later or later/)).toBeNull();
  });
});

const ONE_ROW: ReadonlyArray<PipelineRow> = [
  {
    cycleId: 'cyc-1' as PipelineRow['cycleId'],
    memberId: 'mem-1',
    companyName: 'Acme Co',
    tierBucket: 'premium' as PipelineRow['tierBucket'],
    expiresAt: '2026-12-01T00:00:00.000Z',
    urgency: 't-30',
    status: 'upcoming' as PipelineRow['status'],
    lastReminderAt: null,
    lastReminderStepId: null,
    linkedInvoiceId: null,
    anchored: false,
    closedReason: null,
    emailUnverified: false,
  },
];

describe('<PipelineTable> row actions (item ②)', () => {
  it('renders a VISIBLE "Send reminder" button per row and POSTs to send-reminder-now on click', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ outcome: { kind: 'sent' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} />
      </NextIntlClientProvider>,
    );

    const btn = screen.getByRole('button', { name: 'Send reminder to Acme Co' });
    fireEvent.click(btn);
    // startTransition schedules the async fetch on a microtask.
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/renewals/cyc-1/send-reminder-now',
        { method: 'POST' },
      ),
    );
    vi.unstubAllGlobals();
  });

  // Review fix #2 (controller correction) — h-9 stays the app's
  // text-button convention; 44px (h-11) is reserved for the icon-only ⋯
  // trigger, asserted separately below.
  it('sizes the visible button at h-9 (app text-button convention), NOT h-11', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} />
      </NextIntlClientProvider>,
    );
    const btn = screen.getByRole('button', { name: 'Send reminder to Acme Co' });
    expect(btn.className).toContain('h-9');
    expect(btn.className).not.toContain('h-11');
  });

  // Review fix #4 — progress affordance now that Send-reminder is a
  // persistent button (was a one-shot menu item before item ②).
  it('sets aria-busy and shows a motion-safe spinner while the request is in flight, then clears both', async () => {
    vi.useRealTimers();
    let resolveFetch: (value: unknown) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} />
      </NextIntlClientProvider>,
    );

    const btn = screen.getByRole('button', { name: 'Send reminder to Acme Co' });
    expect(btn).toHaveAttribute('aria-busy', 'false');
    expect(btn.querySelector('svg')).toBeNull();

    fireEvent.click(btn);

    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'true'));
    expect(btn.querySelector('svg')).toBeInTheDocument();

    resolveFetch({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ outcome: { kind: 'sent' } }),
    });

    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'false'));
    expect(btn.querySelector('svg')).toBeNull();

    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });
});

describe('<PipelineTable> row actions — finalFocus after "Mark contacted" (review fix #5)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    baseUiTriggerRef.mockClear();
  });
  afterEach(() => {
    vi.useFakeTimers();
  });

  it("forwards Base UI's own trigger ref to the real ⋯ button (mergeRefs regression guard)", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} />
      </NextIntlClientProvider>,
    );
    expect(baseUiTriggerRef).toHaveBeenCalled();
    const el = baseUiTriggerRef.mock.calls.at(-1)?.[0] as HTMLElement | null;
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el?.getAttribute('aria-label')).toBe('Actions for Acme Co');
  });

  it('returns focus to the row\'s ⋯ trigger (not <body>) after the outreach dialog is CANCELLED', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} />
      </NextIntlClientProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'Actions for Acme Co' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark contacted' }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('returns focus to the row\'s ⋯ trigger after a SUCCESSFUL "Record outreach" submit too', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} />
      </NextIntlClientProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'Actions for Acme Co' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark contacted' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Record outreach' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);

    vi.unstubAllGlobals();
  });
});
