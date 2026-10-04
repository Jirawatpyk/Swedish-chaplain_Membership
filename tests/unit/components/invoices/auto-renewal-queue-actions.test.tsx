/**
 * 107-auto-invoice Task 14 — component tests for
 * `<AutoRenewalQueueActions>` (the review-queue's per-row Issue+Send /
 * Issue silently / Discard actions).
 *
 * Pattern: real `NextIntlClientProvider` + real `en.json` (so assertions
 * read the SHIPPED copy, never a hand-rolled stand-in that could drift),
 * mock `fetch` + `sonner` + `next/navigation` — mirrors
 * `cancel-broadcast-dialog.test.tsx`. Spec 122 US8 (T803): the menu is AURA's
 * real `DropdownMenu` (it renders in jsdom), so the items are found by role
 * and name; `@/components/shell/confirmation-dialog` (AURA's alertdialog) is
 * real too.
 *
 * Real timers required (global setup enables fake timers, which hang
 * `waitFor`) — mirrors every other fetch-driven dialog test in this repo.
 *
 * `cancel-broadcast-dialog.test.tsx` documents Base UI's portal
 * `initialFocus` as jsdom-unreliable for ITS conditional (RAF-racing)
 * focus target. Verified empirically that this specific, UNCONDITIONAL
 * `ConfirmationDialog` usage does NOT hit that limitation — a probe
 * asserting `toHaveFocus()` on Cancel passed deterministically here — so
 * the real focus assertion below is a genuine jsdom proof, not a
 * DOM-order proxy.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import { toast } from '@/lib/toast';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

const { AutoRenewalQueueActions } = await import(
  '@/app/(staff)/admin/invoices/_components/auto-renewal-queue-actions'
);

const t = en.admin.invoices.autoRenewalQueue.actions;
const tQueue = en.admin.invoices.list.queue;

function renderActions(
  extra: Partial<React.ComponentProps<typeof AutoRenewalQueueActions>> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={en as unknown as Record<string, unknown>}>
      <AutoRenewalQueueActions
        invoiceId="inv-draft-1"
        memberName="Acme Co Ltd"
        status="draft"
        {...extra}
      />
    </NextIntlClientProvider>,
  );
}

const ITEM_NAME = {
  'queue-row-issue-send': t.issueAndSend,
  'queue-row-issue-silent': t.issueSilently,
  'queue-row-discard': t.discard,
} as const;

function openMenu() {
  fireEvent.click(screen.getByTestId('queue-row-actions-trigger'));
  return screen.getByRole('menu');
}

function openMenuAndClick(item: keyof typeof ITEM_NAME) {
  const menu = openMenu();
  fireEvent.click(within(menu).getByRole('menuitem', { name: ITEM_NAME[item] }));
}

beforeEach(() => {
  vi.useRealTimers();
  // `mockReset` (not `mockClear`) — several focus-on-close tests give
  // `refreshSpy` a real implementation via `mockImplementation`; a later
  // test relying on the default no-op must not inherit a stale one.
  refreshSpy.mockReset();
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
  (toast.warning as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

describe('<AutoRenewalQueueActions> — visibility gate', () => {
  it('renders nothing for a non-draft row (issued/paid/void/…)', () => {
    renderActions({ status: 'issued' });
    expect(screen.queryByTestId('queue-row-actions-trigger')).toBeNull();
  });

  it('renders the actions trigger for a draft row', () => {
    renderActions();
    expect(screen.getByTestId('queue-row-actions-trigger')).toBeInTheDocument();
  });

  it('the trigger is named for the member', () => {
    renderActions();
    expect(screen.getByTestId('queue-row-actions-trigger')).toHaveAccessibleName(
      t.menuAria.replace('{member}', 'Acme Co Ltd'),
    );
  });

  it('the trigger is 44px on touch, like every card ⋯ (touchHeight)', () => {
    renderActions();
    expect(screen.getByTestId('queue-row-actions-trigger')).toHaveClass('aura-icon-btn--touch');
  });

  it('the menu lists all three actions, each with an icon; Discard is the danger item', () => {
    renderActions();
    const menu = openMenu();
    const silent = within(menu).getByRole('menuitem', { name: t.issueSilently });
    const send = within(menu).getByRole('menuitem', { name: t.issueAndSend });
    const discardItem = within(menu).getByRole('menuitem', { name: t.discard });
    expect(discardItem).toHaveClass('aura-menu__item--danger');
    expect(send).not.toHaveClass('aura-menu__item--danger');
    // Review round 1 SHOULD-FIX — every item carries an icon.
    for (const item of [silent, send, discardItem]) {
      expect(item.querySelector('svg')).toBeInTheDocument();
    }
  });

  it('reorders "Issue silently" BEFORE "Issue and email" (review round 1 SHOULD-FIX — visual weight now matches real risk: email is the higher-impact, externally-visible action)', () => {
    renderActions();
    const names = within(openMenu())
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(names).toEqual([t.issueSilently, t.issueAndSend, t.discard]);
  });
});

describe('<AutoRenewalQueueActions> — Discard (destructive, AlertDialog-gated)', () => {
  it('opens an AlertDialog with the discard copy; focus starts on Cancel (ux-standards.md §6.2 "safest default")', async () => {
    renderActions();
    openMenuAndClick('queue-row-discard');

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(t.discardDialog.title)).toBeInTheDocument();
    expect(
      screen.getByText(
        t.discardDialog.description.replace('{member}', 'Acme Co Ltd'),
      ),
    ).toBeInTheDocument();

    const cancelBtn = screen.getByRole('button', { name: t.cancel });
    expect(cancelBtn).not.toBeDisabled();
    // ConfirmationDialog wires `initialFocus={cancelRef}` unconditionally
    // (ux-standards.md §6.2's "safest default"). Base UI's portal
    // initialFocus DOES fire under jsdom for this unconditional usage
    // (empirically verified — see file header); this is a real focus
    // assertion, not a DOM-order proxy.
    await waitFor(() => expect(cancelBtn).toHaveFocus());
  });

  it('Cancel closes the dialog without calling fetch', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderActions();
    openMenuAndClick('queue-row-discard');
    fireEvent.click(screen.getByRole('button', { name: t.cancel }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Confirm → POSTs to /discard-auto-draft, toasts success, closes, refreshes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ invoice_id: 'inv-draft-1', audit_emitted: true }),
    } as Response);
    renderActions();
    openMenuAndClick('queue-row-discard');
    fireEvent.click(screen.getByRole('button', { name: t.discard }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.toast.discarded));
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/invoices/inv-draft-1/discard-auto-draft',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('409 not_draft → inline focused error, dialog STAYS open (no toast, no close)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'not_draft' } }),
    } as unknown as Response);
    renderActions();
    openMenuAndClick('queue-row-discard');
    fireEvent.click(screen.getByRole('button', { name: t.discard }));

    const alert = await screen.findByTestId('queue-row-action-error');
    expect(alert).toHaveTextContent(t.errors.discardNotDraft);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    // §6.4 "surfaced inline (role=alert), FOCUSED" — not just present in the
    // DOM. This pins the effect-based focus (a naive inline `.focus()` call
    // right after `setError(...)` would target the ref BEFORE React commits
    // the Alert, silently focusing nothing).
    await waitFor(() => expect(alert).toHaveFocus());
  });
});

describe('<AutoRenewalQueueActions> — Issue + Send / Issue silently', () => {
  it('Issue + Send → POSTs sendEmail:true, toasts with the invoice number, refreshes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        invoice_id: 'inv-draft-1',
        invoice_number: 'SC2026-00099',
      }),
    } as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');

    expect(screen.getByText(t.sendDialog.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        t.toast.issuedAndSent.replace('{number}', 'SC2026-00099'),
      ),
    );
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ sendEmail: true });
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('Issue silently → POSTs sendEmail:false (never a "no opinion" default) and says no email will be sent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        invoice_id: 'inv-draft-1',
        invoice_number: 'SC2026-00100',
      }),
    } as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-silent');

    expect(screen.getByText(t.silentDialog.title)).toBeInTheDocument();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ invoice_number: 'SC2026-00100' }),
    } as Response);
    fireEvent.click(screen.getByRole('button', { name: t.issueSilently }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ sendEmail: false });
  });

  it('supersede issues → a persistent, translated warning naming the old bill number + a link to it (never the raw server string)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        invoice_number: 'SC2026-00101',
        supersede_issues: [
          {
            kind: 'void_failed',
            invoice_id: 'inv-old-1',
            bill_document_number: 'SC-2026-000123',
            error_code: 'concurrent_state_change',
          },
          { kind: 'list_failed' },
        ],
      }),
    } as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    // The issue itself succeeded — its toast stays a plain success.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        t.toast.issuedAndSent.replace('{number}', 'SC2026-00101'),
      ),
    );
    const w = en.admin.invoices.supersedeWarning;
    expect(toast.warning).toHaveBeenCalledWith(
      w.title,
      expect.objectContaining({ duration: Infinity, closeButton: true }),
    );
    // AURA 5.6 (handoff #53): each bill line carries its own link and the
    // toast has no action, so opening one bill never hides the others.
    const opts = vi.mocked(toast.warning).mock.calls[0]![1] as {
      description: React.ReactNode;
      action?: unknown;
    };
    expect(opts.action).toBeUndefined();
    const { container } = render(<>{opts.description}</>);
    expect(container).toHaveTextContent(w.voidFailed.replace('{number}', 'SC-2026-000123'));
    expect(container).toHaveTextContent(w.listFailed);
    expect(container.textContent).not.toMatch(/supersede:|inv-old-1/);
    expect(
      within(container).getByRole('link', { name: w.openBill.replace('{number}', 'SC-2026-000123') }),
    ).toHaveAttribute('href', '/admin/invoices/inv-old-1');
  });

  it('two bills to void: one toast lists both, each with its own link', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        invoice_number: 'SC2026-00105',
        supersede_issues: [
          { kind: 'void_failed', invoice_id: 'inv-old-1', bill_document_number: 'SC-2026-000123' },
          { kind: 'void_threw', invoice_id: 'inv-old-2', bill_document_number: 'SC-2026-000125' },
        ],
      }),
    } as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    const w = en.admin.invoices.supersedeWarning;
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    const opts = vi.mocked(toast.warning).mock.calls[0]![1] as { description: React.ReactNode };
    const { container } = render(<>{opts.description}</>);
    const links = within(container).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      [w.openBill.replace('{number}', 'SC-2026-000123'), '/admin/invoices/inv-old-1'],
      [w.openBill.replace('{number}', 'SC-2026-000125'), '/admin/invoices/inv-old-2'],
    ]);
  });

  it('renders the supersede warning in Thai for a TH admin', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        invoice_number: 'SC2026-00102',
        supersede_issues: [
          { kind: 'void_threw', invoice_id: 'inv-old-2', bill_document_number: 'SC-2026-000124' },
        ],
      }),
    } as Response);
    const thT = th.admin.invoices.autoRenewalQueue.actions;
    render(
      <NextIntlClientProvider locale="th" messages={th as unknown as Record<string, unknown>}>
        <AutoRenewalQueueActions invoiceId="inv-draft-1" memberName="Acme Co Ltd" status="draft" />
      </NextIntlClientProvider>,
    );
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: thT.issueSilently }));
    fireEvent.click(screen.getByRole('button', { name: thT.issueSilently }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const [title, opts] = vi.mocked(toast.warning).mock.calls[0]! as [
      string,
      { description: React.ReactNode },
    ];
    const w = th.admin.invoices.supersedeWarning;
    expect(title).toBe(w.title);
    const { container } = render(<>{opts.description}</>);
    expect(container).toHaveTextContent(w.voidFailed.replace('{number}', 'SC-2026-000124'));
    expect(container.textContent).not.toMatch(/supersede:/);
    expect(
      within(container).getByRole('link', { name: w.openBill.replace('{number}', 'SC-2026-000124') }),
    ).toHaveAttribute('href', '/admin/invoices/inv-old-2');
  });

  it('a legacy-only string array (no structured issues) is ignored — no raw server string, no warning', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        invoice_number: 'SC2026-00103',
        supersede_warnings: ['supersede: void of inv-old-3 threw'],
      }),
    } as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('no supersede issues → no warning toast', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ invoice_number: 'SC2026-00104', supersede_issues: [] }),
    } as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('<AutoRenewalQueueActions> — refusal-reason parity with Task 13 queue badges', () => {
  it('duplicate_live_bill renders the SAME copy as <AutoRenewalQueueBadges> + a "View existing invoice" link', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: 'duplicate_live_bill',
          conflicting_invoice_id: 'inv-conflict-9',
          conflicting_status: 'paid',
        },
      }),
    } as unknown as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    const alert = await screen.findByTestId('queue-row-action-error');
    expect(alert).toHaveTextContent(tQueue.refusalReason.duplicateLiveBill);
    const link = screen.getByRole('link', { name: tQueue.viewConflictingInvoice });
    expect(link).toHaveAttribute('href', '/admin/invoices/inv-conflict-9');
    // Review round 1 SHOULD-FIX — 44×44 target, matching the IDENTICAL link
    // in <AutoRenewalQueueBadges> (Task 13 review A7): same key, same page,
    // same meaning.
    // AURA's touch height: 44px on phones and coarse pointers.
    expect(link).toHaveClass('aura-btn--touch');
  });

  it('member_terminated renders the SAME copy as the queue badge', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'member_terminated' } }),
    } as unknown as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-silent');
    fireEvent.click(screen.getByRole('button', { name: t.issueSilently }));

    const alert = await screen.findByTestId('queue-row-action-error');
    expect(alert).toHaveTextContent(tQueue.refusalReason.memberTerminated);
  });

  it('invalid_draft{plan_year_drift} renders the SAME copy as the queue badge', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        error: { code: 'invalid_draft', reason: 'plan_year_drift' },
      }),
    } as unknown as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    const alert = await screen.findByTestId('queue-row-action-error');
    expect(alert).toHaveTextContent(tQueue.refusalReason.planYearDrift);
  });

  it('a row the queue showed as CLEAN does not surprise with a refusal-reason string on an unrelated failure (issue_failed → generic copy, not a fabricated reason)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: { code: 'issue_failed', error_code: 'overflow' } }),
    } as unknown as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    const alert = await screen.findByTestId('queue-row-action-error');
    expect(alert).toHaveTextContent(t.errors.issueFailed);
    expect(alert).not.toHaveTextContent(tQueue.refusalReason.duplicateLiveBill);
    expect(alert).not.toHaveTextContent(tQueue.refusalReason.memberTerminated);
    expect(alert).not.toHaveTextContent(tQueue.refusalReason.planYearDrift);
  });

  // Review round 1 MINOR — cycle_not_found is a DIFFERENT fact than
  // draft_not_found: the draft itself was never issued or discarded, only
  // its cycle link is missing. Must NOT read "may have already been issued
  // or discarded" (that would be actively wrong).
  it('cycle_not_found gets its OWN copy, distinct from draft_not_found\'s "may have already been issued or discarded"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'cycle_not_found' } }),
    } as unknown as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    const alert = await screen.findByTestId('queue-row-action-error');
    expect(alert).toHaveTextContent(t.errors.cycleNotFound);
    expect(alert).not.toHaveTextContent(t.errors.draftNotFound);
  });
});

describe('<AutoRenewalQueueActions> — rate limit (review round 1 MINOR: wait, not failure)', () => {
  it('429 on Issue reads as "wait a moment", not a generic failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: 'rate_limited', retryAfterMs: 12_000 } }),
    } as unknown as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    const alert = await screen.findByTestId('queue-row-action-error');
    // Interpolated ICU plural — assert the resolved 12-second phrasing
    // rather than the raw template.
    expect(alert.textContent).toMatch(/12/);
    expect(alert).not.toHaveTextContent(t.errors.issueFailed);
  });

  it('429 on Discard reads as "wait a moment" too', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: 'rate_limited', retryAfterMs: 3_000 } }),
    } as unknown as Response);
    renderActions();
    openMenuAndClick('queue-row-discard');
    fireEvent.click(screen.getByRole('button', { name: t.discard }));

    const alert = await screen.findByTestId('queue-row-action-error');
    expect(alert.textContent).toMatch(/3/);
    expect(alert).not.toHaveTextContent(t.errors.discardFailed);
  });

  it('429 with no retryAfterMs in the body falls back to the generic "wait a moment" copy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    } as unknown as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-silent');
    fireEvent.click(screen.getByRole('button', { name: t.issueSilently }));

    const alert = await screen.findByTestId('queue-row-action-error');
    expect(alert).toHaveTextContent(t.errors.rateLimited);
  });
});

describe('<AutoRenewalQueueActions> — focus-on-close (review round 1 BLOCKING)', () => {
  // The reviewer's own repro: router.refresh() is mocked as a no-op
  // elsewhere in this file, so the row NEVER actually disappears in jsdom —
  // which is exactly why the original bug was invisible to every earlier
  // test. This harness makes `refresh()` genuinely flip the row's `status`
  // away from 'draft' (the real-world effect of a successful Issue/Discard
  // in the `?origin=auto_renewal` queue view), so `AutoRenewalQueueActions`
  // itself re-renders `null` — the trigger GENUINELY unmounts, the same as
  // in production.
  function Harness() {
    const [status, setStatus] = useState('draft');
    refreshSpy.mockImplementation(() => setStatus('issued'));
    return (
      <>
        {/* Stand-in for the admin/member layout's real `<main id="main-content">`
            landmark (tabIndex={-1} makes it a valid, focusable, non-interactive
            fallback target). */}
        <main id="main-content" tabIndex={-1} data-testid="main-content-stub" />
        <AutoRenewalQueueActions
          invoiceId="inv-draft-1"
          memberName="Acme Co Ltd"
          status={status}
        />
      </>
    );
  }

  function renderHarness() {
    return render(
      <NextIntlClientProvider locale="en" messages={en as unknown as Record<string, unknown>}>
        <Harness />
      </NextIntlClientProvider>,
    );
  }

  it('after a successful Discard the trigger unmounts (row genuinely gone) and focus does NOT drop to <body>', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ invoice_id: 'inv-draft-1', audit_emitted: true }),
    } as Response);
    renderHarness();
    openMenuAndClick('queue-row-discard');
    fireEvent.click(screen.getByRole('button', { name: t.discard }));

    // The row is genuinely gone — the component's own status-gate returns
    // null once `status` flips to 'issued'.
    await waitFor(() =>
      expect(screen.queryByTestId('queue-row-actions-trigger')).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toBe(screen.getByTestId('main-content-stub'));
  });

  it('after a successful Issue the trigger unmounts and focus lands on #main-content, not <body>', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        invoice_id: 'inv-draft-1',
        invoice_number: 'SC2026-00050',
      }),
    } as Response);
    renderHarness();
    openMenuAndClick('queue-row-issue-send');
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    await waitFor(() =>
      expect(screen.queryByTestId('queue-row-actions-trigger')).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toBe(screen.getByTestId('main-content-stub'));
  });

  it('on Cancel (no success) the trigger SURVIVES and gets focus back — the ordinary Base UI default, unaffected', async () => {
    renderHarness();
    openMenuAndClick('queue-row-discard');
    fireEvent.click(screen.getByRole('button', { name: t.cancel }));

    // Cancel never calls refresh — the row survives.
    const trigger = await screen.findByTestId('queue-row-actions-trigger');
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe('<AutoRenewalQueueActions> — Issue-dialog caution (2026-07 UX audit)', () => {
  it('shows a warning caution inside the Issue dialog for a priceChanged row', () => {
    renderActions({ issueCaution: 'priceChanged' });
    openMenuAndClick('queue-row-issue-silent');
    const caution = screen.getByTestId('queue-row-issue-caution');
    expect(caution).toHaveTextContent(t.issueCaution.priceChanged);
    expect(caution).toHaveClass('aura-alert--warning');
  });

  it('shows the priceUnverifiable / unresolved copy for those kinds', () => {
    renderActions({ issueCaution: 'priceUnverifiable' });
    openMenuAndClick('queue-row-issue-send');
    expect(screen.getByTestId('queue-row-issue-caution')).toHaveTextContent(
      t.issueCaution.priceUnverifiable,
    );
  });

  it('renders NO caution for a clean row (issueCaution null/omitted)', () => {
    renderActions();
    openMenuAndClick('queue-row-issue-silent');
    expect(screen.queryByTestId('queue-row-issue-caution')).toBeNull();
  });

  it('does NOT show the caution in the Discard dialog — discarding a flagged row is the safe action', () => {
    renderActions({ issueCaution: 'unresolved' });
    openMenuAndClick('queue-row-discard');
    expect(screen.queryByTestId('queue-row-issue-caution')).toBeNull();
  });
});
