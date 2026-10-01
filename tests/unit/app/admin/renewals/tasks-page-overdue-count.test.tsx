/**
 * /admin/renewals/tasks — overdue count while `?overdue_only=true` is set.
 *
 * The overdue toggle in `<EscalationTaskQueue>` is labelled with (and was
 * gated on) the page's `overdueCount`. The page used to compute that count
 * only when the filter was OFF, so pressing the toggle zeroed the count and
 * the toggle unmounted — focus fell to <body> and only browser Back could
 * clear the filter (spec 122 US7b-2 UX review).
 *
 * Contract pinned here: on the Open tab the overdue count (and its tenant
 * gauge) is read whether or not `overdue_only` is set; other tabs skip it.
 *
 * The async RSC default export is invoked directly with mocked boundaries and
 * rendered with renderToStaticMarkup (same approach as
 * audit-page-load-error.test.tsx); the queue is stubbed to capture its props.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const { countMatching, listForAdminQueue, listDistinctTaskTypes, gaugeSpy, queueProps } =
  vi.hoisted(() => ({
    countMatching: vi.fn(),
    listForAdminQueue: vi.fn(),
    listDistinctTaskTypes: vi.fn(),
    gaugeSpy: vi.fn(),
    queueProps: [] as Array<Record<string, unknown>>,
  }));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ host: 'localhost' })),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));

vi.mock('@/lib/env', () => ({
  env: { features: { f8Renewals: true } },
}));

vi.mock('@/lib/rbac', () => ({
  requirePagePermission: vi
    .fn()
    .mockResolvedValue({ user: { id: 'u1', role: 'admin' } }),
  canPerform: () => true,
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));

vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    observeEscalationTaskOverdueCount: (...args: unknown[]) => gaugeSpy(...args),
    escalationTaskQueueLoadDurationMs: vi.fn(),
  },
}));

vi.mock('@/modules/renewals', () => ({
  ESCALATION_TASK_STATUSES: ['open', 'done', 'skipped'],
  ESCALATION_UNASSIGNED_FILTER: { kind: 'unassigned' },
  makeRenewalsDeps: () => ({
    escalationTaskRepo: { countMatching, listForAdminQueue, listDistinctTaskTypes },
  }),
}));

vi.mock('@/app/(staff)/admin/renewals/tasks/_components/escalation-task-queue', () => ({
  EscalationTaskQueue: (props: Record<string, unknown>) => {
    queueProps.push(props);
    return null;
  },
}));
vi.mock('@/app/(staff)/admin/renewals/_components/renewals-error-retry', () => ({
  RenewalsErrorRetry: () => null,
}));
vi.mock('@/app/(staff)/admin/renewals/_components/renewals-section-tabs', () => ({
  RenewalsSectionTabs: () => null,
}));
vi.mock(
  '@/app/(staff)/admin/renewals/_components/renewals-section-tabs-with-counts',
  () => ({ RenewalsSectionTabsWithCounts: () => null }),
);

import EscalationTaskQueuePage from '@/app/(staff)/admin/renewals/tasks/page';

async function renderPage(searchParams: Record<string, string> = {}): Promise<void> {
  const tree = await EscalationTaskQueuePage({
    searchParams: Promise.resolve(searchParams),
  });
  renderToStaticMarkup(tree as ReactElement);
}

const OVERDUE_QUERY = {
  statusFilter: ['open'],
  overdueOnly: true,
  overdueThresholdDays: 3,
};

beforeEach(() => {
  queueProps.length = 0;
  gaugeSpy.mockClear();
  countMatching.mockReset().mockResolvedValue(4);
  listForAdminQueue.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  listDistinctTaskTypes.mockReset().mockResolvedValue([]);
});

describe('EscalationTaskQueuePage — overdue count', () => {
  it('reads the overdue count while ?overdue_only=true is set, so the toggle keeps its label', async () => {
    await renderPage({ overdue_only: 'true' });

    expect(countMatching).toHaveBeenCalledWith('tenant-a', OVERDUE_QUERY);
    expect(queueProps.at(-1)?.overdueCount).toBe(4);
    expect(gaugeSpy).toHaveBeenCalledWith('tenant-a', 4);
  });

  it('still reads the overdue count (and emits the gauge) when the filter is off', async () => {
    await renderPage();

    expect(countMatching).toHaveBeenCalledWith('tenant-a', OVERDUE_QUERY);
    expect(queueProps.at(-1)?.overdueCount).toBe(4);
    expect(gaugeSpy).toHaveBeenCalledWith('tenant-a', 4);
  });

  it('skips the overdue read outside the Open tab', async () => {
    await renderPage({ status: 'done', overdue_only: 'true' });

    expect(countMatching).not.toHaveBeenCalled();
    expect(gaugeSpy).not.toHaveBeenCalled();
    expect(queueProps.at(-1)?.overdueCount).toBe(0);
  });
});
