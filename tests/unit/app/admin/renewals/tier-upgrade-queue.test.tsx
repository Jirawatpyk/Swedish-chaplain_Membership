/**
 * WP6 — `TierUpgradeQueueClient` render + action-error behaviour.
 *
 * Rendered against the REAL en.json so an evidence / error key regression
 * fails here. Base UI AlertDialog deadlocks under jsdom + startTransition, so
 * the error-toast path is driven through ESCALATE (no dialog) per C-19; the
 * dialog title/copy is asserted only where it renders statically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
vi.mock('sonner', () => ({ toast: h.toast }));

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
    toPlanId: 'plan-b',
    toPlanName: 'Premium — 2026',
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

  it('renders the status via the shared StatusBadge with the mapped tone (P4)', () => {
    renderQueue([makeItem({ status: 'open' })]);
    const badge = screen.getByText(
      enMessages.admin.renewals.tier_upgrades.status.open,
    );
    // The shared primitive stamps data-slot + data-tone; the hand-rolled
    // bg-secondary pill did neither.
    expect(badge).toHaveAttribute('data-slot', 'status-badge');
    expect(badge).toHaveAttribute('data-tone', 'info');
  });

  it('links the resolved company name to the member detail (P1-9)', () => {
    renderQueue([makeItem()]);
    const link = screen.getByRole('link', { name: /Acme Trading Co/ });
    // The full id lives in the href — the actionable, AT-meaningful identifier.
    // enterprise-ux C3 removed the sr-only full-UUID text (a 36-char string read
    // aloud on every row is pure noise).
    expect(link).toHaveAttribute('href', `/admin/members/${MEMBER_UUID}`);
  });

  it('gives the mobile overflow trigger a 44×44 tap target (h-11 w-11, not size-8)', () => {
    renderQueue([makeItem()]);
    const trigger = screen.getByRole('button', {
      name: enMessages.admin.renewals.tier_upgrades.actions.row_menu_aria,
    });
    expect(trigger).toHaveClass('h-11', 'w-11');
    expect(trigger).not.toHaveClass('size-8');
  });

  it('maps a read-only-mode failure to localised copy on a persistent error toast (via Escalate)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: 'read-only-mode' }),
    } as unknown as Response);
    renderQueue([makeItem()]);

    fireEvent.click(screen.getByRole('button', { name: 'Escalate' }));

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

    fireEvent.click(screen.getByRole('button', { name: 'Escalate' }));

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
    expect(
      screen.getByText(
        enMessages.admin.renewals.tier_upgrades.empty_state.title,
      ),
    ).toBeInTheDocument();
  });
});
