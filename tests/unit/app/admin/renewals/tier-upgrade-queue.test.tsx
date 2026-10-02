/**
 * WP6 — `TierUpgradeQueueClient` render + action-error behaviour.
 *
 * Rendered against the REAL en.json so an evidence / error key regression
 * fails here. The error-toast path is driven through ESCALATE (no dialog).
 *
 * 122 US7b-1 (T725), boards `Admin-tier-upgrades` (+ `-accept`, `-mobile`):
 * one AURA DataTable that stacks into cards below 640px; plan cells carry the
 * annual fee excl. VAT; each row has Accept plus a ⋯ menu (Escalate, Dismiss)
 * named for its row; Accept and Dismiss confirm in AURA alertdialogs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { TierUpgradeQueueClient } from '@/app/(staff)/admin/renewals/tier-upgrades/_components/tier-upgrade-queue';
import type { TierUpgradeEvidenceView } from '@/app/(staff)/admin/renewals/tier-upgrades/_lib/tier-upgrade-queue-item';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock('@/lib/toast', () => ({ toast: h.toast }));

const MEMBER_UUID = '11111111-2222-4333-8444-555555555555';

const TURNOVER_EVIDENCE: TierUpgradeEvidenceView = {
  reasonCode: 'declared_turnover_above_threshold',
  turnoverThb: 5_000_000,
  thresholdMetAtLabel: '1 Jul 2026',
};

function makeItem(
  overrides: Partial<Parameters<typeof TierUpgradeQueueClient>[0]['items'][number]> = {},
) {
  return {
    suggestionId: 'sug-1',
    memberId: MEMBER_UUID,
    companyName: 'Acme Trading Co',
    status: 'open',
    fromPlanId: 'plan-a',
    fromPlanName: 'Regular — 2026',
    fromFeeMinorUnits: 1_600_000,
    toPlanId: 'plan-b',
    toPlanName: 'Premium — 2026',
    toFeeMinorUnits: 3_600_000,
    reasonCode: 'declared_turnover_above_threshold',
    evidence: TURNOVER_EVIDENCE,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderQueue(
  items: ReadonlyArray<ReturnType<typeof makeItem>>,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TierUpgradeQueueClient items={items} />
    </NextIntlClientProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

const T = enMessages.admin.renewals.tier_upgrades;

/** The row's ⋯ menu, named for its row (board `Admin-tier-upgrades`). */
function rowMenu(company = 'Acme Trading Co'): HTMLElement {
  return screen.getByRole('button', { name: `Escalate or dismiss — ${company}` });
}

function escalateFromMenu(): void {
  fireEvent.click(rowMenu());
  fireEvent.click(screen.getByRole('menuitem', { name: T.actions.escalate.label }));
}

beforeEach(() => {
  vi.useRealTimers();
  h.toast.error.mockClear();
  h.toast.success.mockClear();
  h.refresh.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TierUpgradeQueueClient — WP6', () => {
  it('renders the pricing evidence line with a narrowSymbol ฿ figure', () => {
    renderQueue([makeItem()]);
    expect(screen.getByText(/฿5,000,000/)).toBeInTheDocument();
    expect(screen.getByText(/1 Jul 2026/)).toBeInTheDocument();
    // Not `THB 5,000,000` (the default currencyDisplay) — narrowSymbol holds ฿.
    expect(screen.queryByText(/THB\s5,000,000/)).toBeNull();
  });

  it('renders the "verify manually" copy when evidence is unavailable', () => {
    renderQueue([makeItem({ evidence: null })]);
    expect(
      screen.getByText(/verify manually before accepting/i),
    ).toBeInTheDocument();
  });

  it('renders the status as an AURA StatusPill in its mapped tone', () => {
    renderQueue([makeItem({ status: 'open' })]);
    const pill = screen
      .getByText(enMessages.admin.renewals.tier_upgrades.status.open)
      .closest('.aura-pill');
    expect(pill).toHaveClass('aura-pill--progress');
  });

  it('links the resolved company name to the member detail (P1-9)', () => {
    renderQueue([makeItem()]);
    const link = screen.getByRole('link', { name: /Acme Trading Co/ });
    // The full id lives in the href — the actionable, AT-meaningful identifier.
    // enterprise-ux C3 removed the sr-only full-UUID text (a 36-char string read
    // aloud on every row is pure noise).
    expect(link).toHaveAttribute('href', `/admin/members/${MEMBER_UUID}`);
  });

  it('maps a read-only-mode failure to localised copy on a persistent error toast (via Escalate)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: 'read-only-mode' }),
    } as unknown as Response);
    renderQueue([makeItem()]);

    escalateFromMenu();

    await vi.waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    const [title, opts] = h.toast.error.mock.calls[0] as [
      string,
      { description: string; duration: number },
    ];
    expect(title).toBe(
      enMessages.admin.renewals.tier_upgrades.actions.escalate.error,
    );
    expect(opts.description).toBe(
      enMessages.admin.renewals.tier_upgrades.action_errors.read_only_mode,
    );
    // ux-standards § 4.2 — error toasts persist until dismissed.
    expect(opts.duration).toBe(Infinity);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('maps an unknown server code to the generic copy (via Escalate)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: 'wibble' } }),
    } as unknown as Response);
    renderQueue([makeItem()]);

    escalateFromMenu();

    await vi.waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    const [, opts] = h.toast.error.mock.calls[0] as [
      string,
      { description: string },
    ];
    expect(opts.description).toBe(
      enMessages.admin.renewals.tier_upgrades.action_errors.unknown,
    );
  });

  it('renders the shared empty state when there are no items', () => {
    renderQueue([]);
    expect(screen.getByTestId('tier-upgrades-empty')).toBeInTheDocument();
    // 122 US7b-1 (T726): the settings link is an AURA secondary button.
    expect(screen.getByRole('link', { name: T.empty_state.cta })).toHaveClass('aura-btn', 'aura-btn--secondary');
    expect(
      screen.getByText(
        enMessages.admin.renewals.tier_upgrades.empty_state.title,
      ),
    ).toBeInTheDocument();
  });
});

describe('TierUpgradeQueueClient on AURA', () => {
  it('is one AURA grid that stacks into cards, titled by the member', () => {
    renderQueue([makeItem()]);
    const grid = screen.getByRole('grid', { name: T.tableCaption });
    expect(grid.closest('.aura-table')).not.toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    const headers = within(grid)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.trim());
    expect(headers.slice(0, 5)).toEqual([
      T.columns.member,
      T.columns.from_plan,
      T.columns.to_plan,
      T.columns.reason,
      T.columns.status,
    ]);
    const memberCell = screen.getByRole('link', { name: 'Acme Trading Co' }).closest('[role="gridcell"]');
    expect(memberCell).toHaveAttribute('data-card', 'title');
    expect(within(grid).getByRole('button', { name: T.actions.accept.label }).closest('[role="gridcell"]')).toHaveAttribute(
      'data-card',
      'footer',
    );
  });

  it('gives the reason and its evidence a full-width line on a phone card (AURA 5.23, #120)', () => {
    renderQueue([makeItem({ evidence: null })]);
    const reason = screen.getByText(/verify manually before accepting/i).closest('[role="gridcell"]');
    expect(reason).toHaveAttribute('data-card', 'wide');
  });

  it('shows each plan with its annual fee excluding VAT', () => {
    renderQueue([makeItem()]);
    expect(screen.getByText('Regular — 2026')).toBeInTheDocument();
    expect(screen.getByText('฿16,000 excl. VAT')).toBeInTheDocument();
    expect(screen.getByText('฿36,000 excl. VAT')).toBeInTheDocument();
  });

  it('offers Accept as the primary button and Escalate / Dismiss in a ⋯ menu named for the row', () => {
    renderQueue([makeItem()]);
    expect(screen.getByRole('button', { name: T.actions.accept.label })).toHaveClass('aura-btn--primary');
    expect(screen.queryByRole('button', { name: T.actions.escalate.label })).toBeNull();
    fireEvent.click(rowMenu());
    expect(screen.getByRole('menuitem', { name: T.actions.escalate.label })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: T.actions.dismiss.label })).toHaveClass('aura-menu__item--danger');
  });

  it('disables the row actions once a suggestion is no longer open', () => {
    renderQueue([makeItem({ status: 'accepted_pending_apply' })]);
    expect(screen.getByRole('button', { name: T.actions.accept.label })).toBeDisabled();
    expect(rowMenu()).toBeDisabled();
  });

  it('restates the evidence, the plan move with fees, and that fees exclude VAT before Accept, then posts it', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    renderQueue([makeItem()]);
    fireEvent.click(screen.getByRole('button', { name: T.actions.accept.label }));
    const dialog = screen.getByRole('alertdialog', { name: T.actions.accept.dialog_title });
    expect(dialog).toHaveClass('aura-dialog');
    expect(dialog).toHaveTextContent('Regular — 2026 (฿16,000) to Premium — 2026 (฿36,000)');
    expect(dialog).toHaveTextContent('Fees exclude VAT.');
    fireEvent.click(within(dialog).getByRole('button', { name: T.actions.accept.label }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/renewals/tier-upgrades/sug-1/accept');
    expect(init).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('confirms Dismiss in a danger alertdialog and posts it', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    renderQueue([makeItem()]);
    fireEvent.click(rowMenu());
    fireEvent.click(screen.getByRole('menuitem', { name: T.actions.dismiss.label }));
    const dialog = screen.getByRole('alertdialog', { name: T.actions.dismiss.dialog_title });
    expect(dialog).toHaveTextContent(T.actions.dismiss.confirm);
    const confirm = within(dialog).getByRole('button', { name: T.actions.dismiss.label });
    expect(confirm).toHaveClass('aura-btn--danger');
    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('/api/admin/renewals/tier-upgrades/sug-1/dismiss');
  });
});

// 122 US7b-1 UX review (T728): focus and busy states on the AURA queue.
describe('TierUpgradeQueueClient — UX review fixes', () => {
  const second = () =>
    makeItem({ suggestionId: 'sug-2', memberId: '22222222-2222-4333-8444-555555555555', companyName: 'Baltic Bay' });

  it('returns focus to the row\'s ⋯ when a Dismiss opened from it is cancelled (M2)', async () => {
    renderQueue([makeItem()]);
    const trigger = rowMenu();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: T.actions.dismiss.label }));
    const dialog = screen.getByRole('alertdialog', { name: T.actions.dismiss.dialog_title });
    fireEvent.click(within(dialog).getByRole('button', { name: T.dialog.cancel }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('keeps the ⋯ focusable while an escalate runs, with its items disabled (M3)', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderQueue([makeItem()]);
    escalateFromMenu();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(rowMenu()).not.toBeDisabled();
    fireEvent.click(rowMenu());
    expect(screen.getByRole('menuitem', { name: T.actions.escalate.label })).toHaveAttribute('aria-disabled', 'true');
  });

  it('an escalate on one row neither busies nor closes the Accept dialog of another (M4)', async () => {
    let settle: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((r) => { settle = r; }));
    renderQueue([makeItem(), second()]);
    fireEvent.click(screen.getByRole('button', { name: 'Escalate or dismiss — Baltic Bay' }));
    fireEvent.click(screen.getByRole('menuitem', { name: T.actions.escalate.label }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole('button', { name: T.actions.accept.label })[0]!);
    const dialog = screen.getByRole('alertdialog', { name: T.actions.accept.dialog_title });
    expect(within(dialog).getByRole('button', { name: T.actions.accept.label })).not.toHaveAttribute('aria-busy', 'true');
    settle({ ok: true, status: 200, json: async () => ({}) });
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());
    expect(screen.getByRole('alertdialog', { name: T.actions.accept.dialog_title })).toBeInTheDocument();
  });

  it('shows the bare fee on a phone with one "Fees exclude VAT." caption, and the suffix from 640px (M7)', () => {
    renderQueue([makeItem()]);
    expect(screen.getByText('฿16,000')).toHaveClass('sm:hidden');
    expect(screen.getByText('฿16,000 excl. VAT')).toHaveClass('max-sm:hidden');
    expect(screen.getByText(T.fees_exclude_vat)).toHaveClass('sm:hidden');
  });

  it('has no VAT caption over the empty state (M7)', () => {
    renderQueue([]);
    expect(screen.queryByText(T.fees_exclude_vat)).toBeNull();
  });
});

// The list card rule (docs/aura-adoption.md § List card): from 640px up the table
// runs edge to edge inside the card (AURA `bleed`, 5.27 #130), keeping its header band.
describe('tier upgrade queue in the list card', () => {
  it('bleeds to the card edges and ends the card (nothing follows it), so the card closes it', () => {
    const { container } = renderQueue([makeItem()]);
    expect(container.querySelector('.aura-bleed.aura-bleed-end')).not.toBeNull();
  });
});
