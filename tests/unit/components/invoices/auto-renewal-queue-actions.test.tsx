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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';

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
    return <>{renderProp ? renderProp({}) : null}</>;
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
  refreshSpy.mockClear();
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
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

  it('the menu lists all three actions', () => {
    renderActions();
    fireEvent.click(screen.getByTestId('queue-row-actions-trigger'));
    expect(screen.getByTestId('queue-row-issue-send')).toHaveTextContent(t.issueAndSend);
    expect(screen.getByTestId('queue-row-issue-silent')).toHaveTextContent(t.issueSilently);
    const discardItem = screen.getByTestId('queue-row-discard');
    expect(discardItem).toHaveTextContent(t.discard);
    expect(discardItem).toHaveAttribute('data-variant', 'destructive');
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
});
