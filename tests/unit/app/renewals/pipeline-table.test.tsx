/**
 * `<PipelineTable>` — the renewal pipeline on AURA `DataTable` (spec 122
 * US7a, T702; Clarifications, Session 2026-09-30 US7 start): ONE table that
 * stacks into cards below 640px, so there is no second (card) list.
 *
 * Suites:
 *   - the month-lens empty copy (`monthLabel` / `monthKind`);
 *   - the visible "Send reminder" row button (promoted out of the ⋯ menu),
 *     with `aria-busy` while the request is in flight;
 *   - the ⋯ row menu (AURA `DropdownMenu`, named after the company) and the
 *     focus return to its trigger after "Mark contacted" opens and closes the
 *     shared `OutreachDialog`;
 *   - the invoice column's "Covered" gate and the manager (`canMutate`) gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** The one AURA grid; there is no separate card list to disambiguate. */
function desktopTable(): HTMLElement {
  return screen.getByRole('grid');
}

const EMPTY_ROWS: ReadonlyArray<PipelineRow> = [];

describe('<PipelineTable> empty state', () => {
  it('renders the month-aware empty copy when monthLabel is set', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} canMutate monthLabel="December 2026" />
      </NextIntlClientProvider>,
    );
    expect(
      screen.getByText('No members renew in December 2026.'),
    ).toBeDefined();
  });

  it('renders the default bucket empty copy when monthLabel is absent', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} canMutate />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('No members in this bucket.')).toBeDefined();
    expect(
      screen.getByText(/Switch to another urgency tab/),
    ).toBeDefined();
  });

  // Deferred fix-wave-2 #4 — dedicated overdue/later empty copy. The bug
  // being pinned: the pre-fix code composed the bucket label into the
  // generic "No members renew in {month}." frame, yielding
  // "No members renew in Overdue." / a doubled "…or later or later".
  it('renders dedicated overdue empty copy when monthKind="overdue"', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={EMPTY_ROWS} canMutate monthKind="overdue" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('No overdue renewals.')).toBeDefined();
  });

  it('renders dedicated later empty copy with a SINGLE "or later" when monthKind="later"', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable
          rows={EMPTY_ROWS}
          canMutate
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
        <PipelineTable rows={ONE_ROW} canMutate />
      </NextIntlClientProvider>,
    );

    const btn = within(desktopTable()).getByRole('button', {
      name: 'Send reminder to Acme Co',
    });
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

  // AURA `Button` size `sm` (32px in the grid row) that grows to 44px on a
  // phone (`touchHeight`, the stacked card's full-width action).
  it('is an AURA secondary button, small in the grid and touch height on phones', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} canMutate />
      </NextIntlClientProvider>,
    );
    const btn = within(desktopTable()).getByRole('button', {
      name: 'Send reminder to Acme Co',
    });
    expect(btn).toHaveClass('aura-btn', 'aura-btn--secondary', 'aura-btn--sm', 'aura-btn--touch');
  });

  // Review fix #4 — progress affordance now that Send-reminder is a
  // persistent button (was a one-shot menu item before item ②).
  it('sets aria-busy (AURA loading) while the request is in flight, then clears it', async () => {
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
        <PipelineTable rows={ONE_ROW} canMutate />
      </NextIntlClientProvider>,
    );

    const btn = within(desktopTable()).getByRole('button', {
      name: 'Send reminder to Acme Co',
    });
    expect(btn).not.toHaveAttribute('aria-busy');

    fireEvent.click(btn);

    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'true'));

    resolveFetch({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ outcome: { kind: 'sent' } }),
    });

    await waitFor(() => expect(btn).not.toHaveAttribute('aria-busy'));

    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });
});

describe('<PipelineTable> row menu — AURA DropdownMenu, focus back on its trigger after "Mark contacted"', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useFakeTimers();
  });

  it('the ⋯ trigger is an AURA icon button that opens a menu named after the company', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} canMutate />
      </NextIntlClientProvider>,
    );
    const trigger = within(desktopTable()).getByRole('button', {
      name: 'Actions for Acme Co',
    });
    expect(trigger).toHaveClass('aura-icon-btn');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'Actions for Acme Co' })).toBeInTheDocument();
  });

  it('returns focus to the row\'s ⋯ trigger (not <body>) after the outreach dialog is CANCELLED', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} canMutate />
      </NextIntlClientProvider>,
    );

    const trigger = within(desktopTable()).getByRole('button', {
      name: 'Actions for Acme Co',
    });
    fireEvent.click(trigger);
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Mark contacted' }),
    );

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
        <PipelineTable rows={ONE_ROW} canMutate />
      </NextIntlClientProvider>,
    );

    const trigger = within(desktopTable()).getByRole('button', {
      name: 'Actions for Acme Co',
    });
    fireEvent.click(trigger);
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Mark contacted' }),
    );
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Record outreach' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);

    vi.unstubAllGlobals();
  });
});

// Fix round 3 (manager money-CTA gating) — `canMutate` hides the pipeline
// row's MUTATION affordances (Send reminder button + Mark-paid item) from a
// read-only manager, while keeping Open (read-only navigation) AND Mark
// contacted (`record-at-risk-outreach` — FR-033 + FR-052a's ONE manager
// mutation exception, never 403s for manager) visible regardless of role.
// `status: 'awaiting_payment'` (a PAYABLE_STATUSES member — see
// `mark-paid-gate.ts`) so "Mark paid" would render under `canMutate={true}`,
// proving its absence under `canMutate={false}` is the prop gate and not the
// status gate.
const PAYABLE_ROW: ReadonlyArray<PipelineRow> = [
  {
    cycleId: 'cyc-2' as PipelineRow['cycleId'],
    memberId: 'mem-2',
    companyName: 'Beta Co',
    tierBucket: 'premium' as PipelineRow['tierBucket'],
    expiresAt: '2026-12-01T00:00:00.000Z',
    urgency: 't-30',
    status: 'awaiting_payment' as PipelineRow['status'],
    lastReminderAt: null,
    lastReminderStepId: null,
    linkedInvoiceId: null,
    anchored: false,
    closedReason: null,
    emailUnverified: false,
  },
];

// 059-membership-suspension covered-gate fix — the invoice column's green
// "Covered" label previously showed for ANY anchored cycle regardless of
// urgency, so a PAST-expiry anchored cycle (urgency `suspended`/
// `terminated`) misleadingly read "Covered" even though its covered period
// has already ended and a renewal is effectively owed. `lastReminderAt` is
// overridden to a non-null ISO string in the suspended/terminated cases so
// the invoice column's "—" is the ONLY em-dash in the row (ONE_ROW's default
// `lastReminderAt: null` also renders "—" in the last_reminder column,
// which would make an unscoped "—" query ambiguous).
describe('<PipelineTable> invoice column — "Covered" gated to pre-expiry urgency (covered-gate fix)', () => {
  it('shows "Covered" for an anchored cycle with pre-expiry (countdown) urgency and no linked invoice (regression guard)', () => {
    const rows: ReadonlyArray<PipelineRow> = [
      { ...ONE_ROW[0]!, anchored: true, urgency: 't-30', linkedInvoiceId: null },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={rows} canMutate />
      </NextIntlClientProvider>,
    );
    expect(within(desktopTable()).getByText('Covered')).toBeInTheDocument();
  });

  it('falls through to "—", NOT "Covered", for an anchored cycle whose urgency is "suspended" (past-expiry — the bug this fixes)', () => {
    const rows: ReadonlyArray<PipelineRow> = [
      {
        ...ONE_ROW[0]!,
        anchored: true,
        urgency: 'suspended',
        linkedInvoiceId: null,
        lastReminderAt: '2020-01-01T00:00:00.000Z',
      },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={rows} canMutate />
      </NextIntlClientProvider>,
    );
    expect(within(desktopTable()).queryByText('Covered')).toBeNull();
    expect(within(desktopTable()).getByText('—')).toBeInTheDocument();
  });

  it('falls through to "—", NOT "Covered", for an anchored cycle whose urgency is "terminated" (past-expiry)', () => {
    const rows: ReadonlyArray<PipelineRow> = [
      {
        ...ONE_ROW[0]!,
        anchored: true,
        urgency: 'terminated',
        linkedInvoiceId: null,
        lastReminderAt: '2020-01-01T00:00:00.000Z',
      },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={rows} canMutate />
      </NextIntlClientProvider>,
    );
    expect(within(desktopTable()).queryByText('Covered')).toBeNull();
    expect(within(desktopTable()).getByText('—')).toBeInTheDocument();
  });

  it('renders "View invoice" when linkedInvoiceId is set, regardless of urgency (unchanged)', () => {
    const rows: ReadonlyArray<PipelineRow> = [
      { ...ONE_ROW[0]!, anchored: true, urgency: 'suspended', linkedInvoiceId: 'inv-1' },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={rows} canMutate />
      </NextIntlClientProvider>,
    );
    const link = within(desktopTable()).getByRole('link', { name: 'View invoice' });
    expect(link).toHaveAttribute('href', '/admin/invoices/inv-1');
  });
});

describe('<PipelineTable> canMutate gating (manager money-CTA hiding)', () => {
  // Same real-timers discipline as the finalFocus suite above: the shared
  // Vitest setup installs fake timers, under which `screen.findByRole`'s
  // internal `waitFor` polling never resolves and the test spins to the 30s
  // timeout (30s-timeout-is-harness-not-component gotcha).
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useFakeTimers();
  });

  it('canMutate={false}: hides the visible Send-reminder button + the Mark-paid menu item, keeps Open + Mark contacted', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={PAYABLE_ROW} canMutate={false} />
      </NextIntlClientProvider>,
    );

    // The one-click "Send reminder" button is not rendered at all for a
    // read-only manager (not merely disabled).
    expect(
      screen.queryByRole('button', { name: /send reminder/i }),
    ).toBeNull();

    const trigger = within(desktopTable()).getByRole('button', {
      name: /actions for beta co/i,
    });
    fireEvent.click(trigger);

    expect(
      await screen.findByRole('menuitem', { name: /open/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: /mark contacted/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: /mark paid/i }),
    ).toBeNull();
  });

  it('canMutate={true}: shows Send-reminder, Mark paid, Mark contacted, and Open', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={PAYABLE_ROW} canMutate />
      </NextIntlClientProvider>,
    );

    expect(
      within(desktopTable()).getByRole('button', { name: /send reminder/i }),
    ).toBeInTheDocument();

    const trigger = within(desktopTable()).getByRole('button', {
      name: /actions for beta co/i,
    });
    fireEvent.click(trigger);

    expect(
      await screen.findByRole('menuitem', { name: /open/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: /mark contacted/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: /mark paid/i }),
    ).toBeInTheDocument();
  });
  // A payable row that already has a live linked bill: the use-case refuses
  // mint-and-pay (`membership_bill_already_exists`), so the ⋯ menu must not
  // offer "Mark paid" — it links to the bill's Record payment flow instead.
  it('canMutate={true} + live linked bill: no Mark paid, offers "Record payment on invoice" instead', async () => {
    const rows: ReadonlyArray<PipelineRow> = [
      { ...PAYABLE_ROW[0]!, linkedInvoiceId: 'inv-9', linkedInvoiceLive: true },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={rows} canMutate />
      </NextIntlClientProvider>,
    );

    fireEvent.click(
      within(desktopTable()).getByRole('button', { name: /actions for beta co/i }),
    );

    // AURA menu items carry their visible label; the menu itself is named
    // after the company ("Actions for Beta Co").
    const menu = await screen.findByRole('menu', { name: 'Actions for Beta Co' });
    const record = within(menu).getByRole('menuitem', { name: 'Record payment on invoice' });
    expect(record).toHaveAttribute('href', '/admin/invoices/inv-9');
    expect(
      screen.queryByRole('menuitem', { name: /mark paid/i }),
    ).toBeNull();
  });

  // A payable row still LINKED to a VOID invoice (void-on-reissue supersede /
  // pre-unlink voids): there is nothing to pay on that invoice, and
  // mark-paid-offline clears such a stale link before minting (#409) — so the
  // row offers "Mark paid", never a "Record payment" link to a void invoice.
  it('canMutate={true} + link to a VOID invoice: offers Mark paid, not "Record payment on invoice"', async () => {
    const rows: ReadonlyArray<PipelineRow> = [
      { ...PAYABLE_ROW[0]!, linkedInvoiceId: 'inv-void', linkedInvoiceLive: false },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={rows} canMutate />
      </NextIntlClientProvider>,
    );

    fireEvent.click(
      within(desktopTable()).getByRole('button', { name: /actions for beta co/i }),
    );

    const menu = await screen.findByRole('menu', { name: 'Actions for Beta Co' });
    expect(within(menu).getByRole('menuitem', { name: /mark paid/i })).toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Record payment on invoice' }),
    ).toBeNull();
  });
});

// T702 — one table, cards on a phone (Clarifications, Session 2026-09-30 US7
// start). jsdom has no layout, so AURA renders the grid; the card anatomy is
// the columns' `data-card` parts, which the stacked cards read.
describe('<PipelineTable> one AURA table that stacks into cards', () => {
  it('renders one AURA grid named after the pipeline and no separate card list', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} canMutate />
      </NextIntlClientProvider>,
    );
    expect(screen.getAllByRole('grid')).toHaveLength(1);
    expect(screen.getByRole('grid', { name: 'Renewal pipeline' }).closest('.aura-table')).not.toBeNull();
    expect(screen.queryByTestId('pipeline-card-list')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('a card is titled by the company, with the urgency pill and the row actions (board Admin-renewals-mobile)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} canMutate />
      </NextIntlClientProvider>,
    );
    const cells = within(screen.getByRole('grid')).getAllByRole('gridcell');
    const part = (text: string | RegExp) =>
      cells.find((c) => within(c).queryByText(text))?.getAttribute('data-card');
    expect(part('Acme Co')).toBe('title');
    expect(part(/Renews in 30d|T-30/i)).toBe('pill');
    const actions = within(screen.getByRole('grid'))
      .getByRole('button', { name: 'Send reminder to Acme Co' })
      .closest('[role="gridcell"]');
    expect(actions).toHaveAttribute('data-card', 'footer');
  });

  it('the row actions sit directly in the AURA cell, so the card footer grows "Send reminder" beside the ⋯ (AURA 5.22, #118)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} canMutate />
      </NextIntlClientProvider>,
    );
    const grid = within(screen.getByRole('grid'));
    const send = grid.getByRole('button', { name: 'Send reminder to Acme Co' });
    const menu = grid.getByRole('button', { name: /^Actions for Acme Co/ });
    expect(send.parentElement).toHaveClass('aura-table__cell');
    expect(menu.closest('.aura-dropdown')?.parentElement).toBe(send.parentElement);
    expect(document.querySelector('[data-pipeline-row-actions]')).toBeNull();
  });

  it('the invoice column stays in the grid but leaves the phone card, as the board draws it', () => {
    const rows: ReadonlyArray<PipelineRow> = [{ ...ONE_ROW[0]!, linkedInvoiceId: 'inv-1' }];
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={rows} canMutate />
      </NextIntlClientProvider>,
    );
    const invoiceCell = screen.getByRole('link', { name: 'View invoice' }).closest('[role="gridcell"]');
    expect(invoiceCell).toHaveAttribute('data-card', 'hide');
  });
});

describe('<PipelineTable> column breakpoints (maintainer, 1 Oct: Last reminder at 1440)', () => {
  it('shows Last reminder from a 1040px table (the 1440 screen has 1071px) and gives Invoice the wide screens; the actions column fits SV "Skicka påminnelse" at 200px', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} canMutate />
      </NextIntlClientProvider>,
    );
    const header = (name: string) =>
      within(screen.getByRole('grid'))
        .getAllByRole('columnheader')
        .find((th) => th.textContent?.trim() === name);
    // AURA DataTable turns each hideBelow into a level, widest first: Invoice
    // (1180) is level 1 and Last reminder (1040) level 2. Each level's probe
    // carries the ratio to the level before it (stack 640 → 1180 → 1040).
    expect(header('Invoice')).toHaveAttribute('data-hide', '1');
    expect(header('Last reminder')).toHaveAttribute('data-hide', '2');
    const scale = (level: string) =>
      (document.querySelector(`.aura-table-q--${level}`) as HTMLElement | null)?.style.getPropertyValue('--aura-q-scale');
    expect(scale('h1')).toBe(String(640 / 1180));
    expect(scale('h2')).toBe(String(1180 / 1040));
    const actions = within(screen.getByRole('grid'))
      .getAllByRole('columnheader')
      .at(-1);
    expect(actions?.getAttribute('style')).toContain('--aura-cell-w: 200px');
  });
});


// The list card rule (docs/aura-adoption.md § List card): from 640px up the table
// runs edge to edge inside the card (AURA `bleed`, 5.27 #130), keeping its header band.
describe('<PipelineTable> in the list card', () => {
  it('bleeds to the card edges; the bulk bar and "Next 50" can follow it, so it does not end the card', () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineTable rows={ONE_ROW} canMutate />
      </NextIntlClientProvider>,
    );
    expect(container.querySelector('.aura-bleed')).not.toBeNull();
    expect(container.querySelector('.aura-bleed-end')).toBeNull();
  });
});
