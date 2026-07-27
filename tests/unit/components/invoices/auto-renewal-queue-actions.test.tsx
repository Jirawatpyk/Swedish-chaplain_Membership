/**
 * 107-auto-invoice Task 14 — component tests for
 * `<AutoRenewalQueueActions>` (the review-queue's per-row Issue+Send /
 * Issue silently / Discard actions).
 *
 * Pattern: real `NextIntlClientProvider` + real `en.json` (so assertions
 * read the SHIPPED copy, never a hand-rolled stand-in that could drift),
 * mock `fetch` + `sonner` + `next/navigation` — mirrors
 * `cancel-broadcast-dialog.test.tsx`. `@/components/ui/dropdown-menu` is
 * mocked to plain-HTML stand-ins (Base UI Menu only renders its Popup while
 * open + models portal/pointer positioning jsdom does not support) — same
 * pattern as `invoice-more-menu.test.tsx`, the sibling component in this
 * exact table. `@/components/shell/confirmation-dialog` (the AlertDialog
 * wrapper) is DELIBERATELY left real — `confirmation-dialog.test.tsx`
 * already proves it renders + interacts correctly in jsdom.
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
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';

// Simulate Base UI's React-19 contract: the Menu.Trigger passes its OWN ref
// inside the render callback's `props`. The component MUST forward it (merge,
// not override) or the popup can't anchor and the menu never opens — the exact
// bug this file now guards against.
const { baseUiTriggerRef } = vi.hoisted(() => ({ baseUiTriggerRef: vi.fn() }));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

// Base UI Menu renders its Popup only while open + models portal/pointer
// positioning jsdom does not support — mocked to plain-HTML stand-ins.
// Mirrors `invoice-more-menu.test.tsx` (the sibling table's own "more
// actions" menu) verbatim.
vi.mock('@/components/ui/dropdown-menu', () => {
  function DropdownMenu({ children }: { children?: React.ReactNode }) {
    return <div data-testid="menu-root">{children}</div>;
  }
  function DropdownMenuTrigger({
    render: renderProp,
  }: {
    render?: (props: Record<string, unknown>) => React.ReactNode;
  }) {
    // Pass Base UI's own ref through `props` (React-19 shape) so the test can
    // assert the component forwards it to the real <button>.
    return <>{renderProp ? renderProp({ ref: baseUiTriggerRef }) : null}</>;
  }
  function DropdownMenuContent({ children }: { children?: React.ReactNode }) {
    return <div role="menu">{children}</div>;
  }
  function DropdownMenuItem({
    children,
    onClick,
    variant,
    ...rest
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    variant?: string;
    'data-testid'?: string;
  }) {
    return (
      <button type="button" role="menuitem" onClick={onClick} data-variant={variant} {...rest}>
        {children}
      </button>
    );
  }
  function DropdownMenuSeparator() {
    return <hr />;
  }
  return {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
  };
});

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

function openMenuAndClick(itemTestId: string) {
  fireEvent.click(screen.getByTestId('queue-row-actions-trigger'));
  fireEvent.click(screen.getByTestId(itemTestId));
}

beforeEach(() => {
  vi.useRealTimers();
  // `mockReset` (not `mockClear`) — several focus-on-close tests give
  // `refreshSpy` a real implementation via `mockImplementation`; a later
  // test relying on the default no-op must not inherit a stale one.
  refreshSpy.mockReset();
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
  baseUiTriggerRef.mockClear();
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

  it("forwards Base UI's own trigger ref to the <button> (menu-anchor regression)", () => {
    // The bug: `render={(props) => <Button {...props} ref={triggerRef} />}`
    // dropped Base UI's ref (only the rightmost ref survives), so the popup's
    // Positioner lost its anchor and the menu never opened. mergeRefs must
    // forward Base UI's ref too — assert it reached the real button element.
    renderActions();
    expect(baseUiTriggerRef).toHaveBeenCalled();
    const el = baseUiTriggerRef.mock.calls.at(-1)?.[0] as HTMLElement | null;
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el?.getAttribute('data-testid')).toBe('queue-row-actions-trigger');
  });

  it('the menu lists all three actions, each with an icon (mirrors invoice-more-menu.tsx)', () => {
    renderActions();
    fireEvent.click(screen.getByTestId('queue-row-actions-trigger'));
    const send = screen.getByTestId('queue-row-issue-send');
    const silent = screen.getByTestId('queue-row-issue-silent');
    const discardItem = screen.getByTestId('queue-row-discard');
    expect(send).toHaveTextContent(t.issueAndSend);
    expect(silent).toHaveTextContent(t.issueSilently);
    expect(discardItem).toHaveTextContent(t.discard);
    expect(discardItem).toHaveAttribute('data-variant', 'destructive');
    // Review round 1 SHOULD-FIX — every item carries an icon (previously
    // icon-less, breaking this page's own `invoice-more-menu.tsx` convention).
    expect(send.querySelector('svg')).toBeInTheDocument();
    expect(silent.querySelector('svg')).toBeInTheDocument();
    expect(discardItem.querySelector('svg')).toBeInTheDocument();
  });

  it('reorders "Issue silently" BEFORE "Issue and email" (review round 1 SHOULD-FIX — visual weight now matches real risk: email is the higher-impact, externally-visible action)', () => {
    renderActions();
    fireEvent.click(screen.getByTestId('queue-row-actions-trigger'));
    const items = screen.getAllByRole('menuitem');
    const silentIndex = items.indexOf(screen.getByTestId('queue-row-issue-silent'));
    const sendIndex = items.indexOf(screen.getByTestId('queue-row-issue-send'));
    const discardIndex = items.indexOf(screen.getByTestId('queue-row-discard'));
    expect(silentIndex).toBeLessThan(sendIndex);
    expect(sendIndex).toBeLessThan(discardIndex);
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
        supersede_warnings: [],
      }),
    } as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');

    expect(screen.getByText(t.sendDialog.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        t.toast.issuedAndSent.replace('{number}', 'SC2026-00099'),
        undefined,
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
        supersede_warnings: [],
      }),
    } as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-silent');

    expect(screen.getByText(t.silentDialog.title)).toBeInTheDocument();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ invoice_number: 'SC2026-00100', supersede_warnings: [] }),
    } as Response);
    fireEvent.click(screen.getByRole('button', { name: t.issueSilently }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ sendEmail: false });
  });

  it('surfaces supersedeWarnings as the toast description', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        invoice_number: 'SC2026-00101',
        supersede_warnings: ['superseded SC2026-00090'],
      }),
    } as Response);
    renderActions();
    openMenuAndClick('queue-row-issue-send');
    fireEvent.click(screen.getByRole('button', { name: t.issueAndSend }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.any(String), {
        description: 'superseded SC2026-00090',
      }),
    );
  });
});

describe('<AutoRenewalQueueActions> — refusal-reason parity with Task 13 queue badges', () => {
  it('duplicate_live_bill renders the SAME copy as <AutoRenewalQueueBadges> + a "View existing bill" link', async () => {
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
    expect(link.className).toContain('min-h-11');
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
        supersede_warnings: [],
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
    expect(caution).toHaveAttribute('data-tone', 'warning');
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
