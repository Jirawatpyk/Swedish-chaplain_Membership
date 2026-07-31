/**
 * Enhancement C3 (#8) — `<RenewalsSectionTabsWithCounts>` unit tests.
 *
 * The count-bearing section-tabs island was previously inline in the pipeline
 * `page.tsx` (so the Pending review / Tasks / Tier upgrades badges only ever
 * rendered on the Pipeline page). It is now a shared server component rendered
 * on ALL four renewals surfaces. These tests pin:
 *   - the three EXISTING reads wire into the three tab count badges, and
 *   - best-effort degradation: one read throwing hides only THAT badge (count
 *     0) and logs a distinct errorId, never blanking the strip.
 *
 * The async RSC body is invoked directly and its returned (client) element is
 * rendered under a real NextIntlClientProvider + real en.json (a missing key
 * would surface as a raw key, mirroring `renewals-section-tabs.test.tsx`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

// Hoisted so the vi.mock factories (themselves hoisted above module top) can
// reference these without the "cannot access before initialization" trap.
const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  loadPendingReactivationReview: vi.fn(),
  countMatching: vi.fn(),
  listForAdminQueue: vi.fn(),
}));

// The rendered client strip reads the router hooks; give it a static pipeline
// location so exactly one tab is active and no count badge depends on nav state.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/admin/renewals',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: mocks.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: () => ({
    escalationTaskRepo: { countMatching: mocks.countMatching },
    tierUpgradeRepo: { listForAdminQueue: mocks.listForAdminQueue },
  }),
  loadPendingReactivationReview: (...args: unknown[]) =>
    mocks.loadPendingReactivationReview(...args),
}));

import { RenewalsSectionTabsWithCounts } from '@/app/(staff)/admin/renewals/_components/renewals-section-tabs-with-counts';

function pendingOk(openCount: number, settlingCount = 0) {
  const cycles = [
    ...Array.from({ length: openCount }, () => ({
      rejectRefundInitiatedAt: null,
    })),
    ...Array.from({ length: settlingCount }, () => ({
      rejectRefundInitiatedAt: '2026-01-01T00:00:00.000Z',
    })),
  ];
  return { ok: true as const, value: { cycles } };
}

async function renderWithCounts(showPipelineHelp = false) {
  const el = await RenewalsSectionTabsWithCounts({
    tenantSlug: 'tenant-a',
    showPipelineHelp,
  });
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      {el}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  mocks.loggerError.mockClear();
  mocks.loadPendingReactivationReview.mockReset();
  mocks.countMatching.mockReset();
  mocks.listForAdminQueue.mockReset();
});

describe('<RenewalsSectionTabsWithCounts> wires the three reads into the badges', () => {
  it('renders each count badge from its read (pending-review honest open-count excludes refund-settling)', async () => {
    mocks.loadPendingReactivationReview.mockResolvedValue(pendingOk(2, 1)); // 2 open, 1 settling → badge 2
    mocks.countMatching.mockResolvedValue(7);
    mocks.listForAdminQueue.mockResolvedValue({ items: [{}, {}, {}] }); // 3

    await renderWithCounts();

    expect(
      screen.getByRole('tab', { name: /pending review/i }).textContent,
    ).toContain('2');
    expect(screen.getByText(/2 cycles awaiting review/i)).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /^tasks/i }).textContent,
    ).toContain('7');
    expect(screen.getByText(/7 open tasks/i)).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /tier upgrades/i }).textContent,
    ).toContain('3');
    expect(screen.getByText(/3 tier-upgrade suggestions/i)).toBeInTheDocument();
  });

  it('passes the open status filter + the 50-row queue cap to the reads', async () => {
    mocks.loadPendingReactivationReview.mockResolvedValue(pendingOk(0));
    mocks.countMatching.mockResolvedValue(0);
    mocks.listForAdminQueue.mockResolvedValue({ items: [] });

    await renderWithCounts();

    expect(mocks.countMatching).toHaveBeenCalledWith('tenant-a', {
      statusFilter: ['open'],
    });
    expect(mocks.listForAdminQueue).toHaveBeenCalledWith('tenant-a', {
      limit: 50,
    });
  });
});

describe('<RenewalsSectionTabsWithCounts> best-effort degradation (one read throws)', () => {
  it('a failed tasks read hides only the Tasks badge and logs its errorId; other badges survive', async () => {
    mocks.loadPendingReactivationReview.mockResolvedValue(pendingOk(2));
    mocks.countMatching.mockRejectedValue(new Error('boom'));
    mocks.listForAdminQueue.mockResolvedValue({ items: [{}] });

    await renderWithCounts();

    // Tasks badge absent (count degraded to 0)…
    expect(screen.queryByText(/open tasks?/i)).not.toBeInTheDocument();
    // …while the other two still render.
    expect(screen.getByText(/2 cycles awaiting review/i)).toBeInTheDocument();
    expect(screen.getByText(/1 tier-upgrade suggestion/i)).toBeInTheDocument();
    // A distinct errorId is logged for SRE triage.
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ errorId: 'F8.ADMIN.TASKS_COUNT' }),
      expect.any(String),
    );
  });

  it('a failed pending-review read hides only the Pending review badge and logs its errorId', async () => {
    mocks.loadPendingReactivationReview.mockRejectedValue(new Error('boom'));
    mocks.countMatching.mockResolvedValue(4);
    mocks.listForAdminQueue.mockResolvedValue({ items: [] });

    await renderWithCounts();

    expect(screen.queryByText(/awaiting review/i)).not.toBeInTheDocument();
    expect(screen.getByText(/4 open tasks/i)).toBeInTheDocument();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ errorId: 'F8.ADMIN.PENDING_REVIEW_COUNT' }),
      expect.any(String),
    );
  });

  it('a failed tier-upgrade read hides only the Tier upgrades badge and logs its errorId', async () => {
    mocks.loadPendingReactivationReview.mockResolvedValue(pendingOk(2));
    mocks.countMatching.mockResolvedValue(4);
    mocks.listForAdminQueue.mockRejectedValue(new Error('boom'));

    await renderWithCounts();

    // Tier-upgrades badge absent (count degraded to 0)…
    expect(
      screen.queryByText(/tier-upgrade suggestions?/i),
    ).not.toBeInTheDocument();
    // …while the other two still render.
    expect(screen.getByText(/2 cycles awaiting review/i)).toBeInTheDocument();
    expect(screen.getByText(/4 open tasks/i)).toBeInTheDocument();
    // A distinct errorId is logged for SRE triage.
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ errorId: 'F8.ADMIN.TIER_UPGRADE_COUNT' }),
      expect.any(String),
    );
  });
});

describe('<RenewalsSectionTabsWithCounts> help popover pass-through', () => {
  it('forwards showPipelineHelp so the help trigger only renders when asked', async () => {
    mocks.loadPendingReactivationReview.mockResolvedValue(pendingOk(0));
    mocks.countMatching.mockResolvedValue(0);
    mocks.listForAdminQueue.mockResolvedValue({ items: [] });

    await renderWithCounts(true);

    expect(
      screen.getByRole('button', { name: 'About the renewal pipeline' }),
    ).toBeInTheDocument();
  });
});
