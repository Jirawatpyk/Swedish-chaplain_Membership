/**
 * F8 Phase 4 Wave I2c · T088 spec — `dispatchRenewalCycle` use-case.
 *
 * Cron-loop scope: input validation + cursor pagination + summary
 * aggregation. Per-cycle decision tree is tested in
 * `_lib/dispatch-one-cycle.test.ts`; here we mock the core fn.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { assertOk } from '../../_helpers/assert-result';
import { buildDispatchCandidate } from '../../_helpers/build-cycle';
import {
  dispatchRenewalCycle,
  DEFAULT_PAGE_SIZE,
} from '@/modules/renewals/application/use-cases/dispatch-renewal-cycle';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { DispatchCandidate } from '@/modules/renewals/application/ports/dispatch-candidate-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';

const TENANT_ID = 'tenantA';
const NOW_ISO = '2026-05-15T00:00:00.000Z';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

vi.mock('@/lib/env', () => ({
  env: {
    features: { f8Renewals: true },
    flags: { readOnlyMode: false },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

// Stub dispatchOneCycle so we control outcomes per test.
vi.mock(
  '@/modules/renewals/application/use-cases/_lib/dispatch-one-cycle',
  async () => {
    const actual = await vi.importActual<
      typeof import('@/modules/renewals/application/use-cases/_lib/dispatch-one-cycle')
    >('@/modules/renewals/application/use-cases/_lib/dispatch-one-cycle');
    return {
      ...actual,
      dispatchOneCycle: vi.fn(),
    };
  },
);

import { dispatchOneCycle } from '@/modules/renewals/application/use-cases/_lib/dispatch-one-cycle';

function buildCandidate(cycleId: string): DispatchCandidate {
  return buildDispatchCandidate({
    cycle: {
      tenantId: TENANT_ID,
      cycleId: asCycleId(cycleId),
      status: 'upcoming' as const,
      periodFrom: '2026-05-15T00:00:00.000Z',
      periodTo: '2027-05-15T00:00:00.000Z',
      expiresAt: '2026-06-14T00:00:00.000Z',
    },
  });
}

function fakeDeps(pages: ReadonlyArray<DispatchCandidate>[]): {
  deps: RenewalsDeps;
  listMock: ReturnType<typeof vi.fn>;
} {
  let pageIdx = 0;
  const listMock = vi.fn(async () => {
    const items = pages[pageIdx] ?? [];
    pageIdx += 1;
    const hasMore = pageIdx < pages.length;
    return { items, nextCursor: hasMore ? `c-${pageIdx}` : null };
  });
  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    dispatchCandidateRepo: { list: listMock, findOne: vi.fn() } as unknown as RenewalsDeps['dispatchCandidateRepo'],
  } as unknown as RenewalsDeps;
  return { deps, listMock };
}

const VALID_INPUT = {
  tenantId: TENANT_ID,
  correlationId: 'corr-1',
  nowIso: NOW_ISO,
};

describe('dispatchRenewalCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: 1 page, 2 candidates, both sent → summary counts emails=2', async () => {
    const candidates = [buildCandidate('c-001'), buildCandidate('c-002')];
    (dispatchOneCycle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({ kind: 'sent', reminderEventId: 'r1', deliveryId: 'd1', dispatchedAt: NOW_ISO }),
    );
    const { deps } = fakeDeps([candidates]);
    const result = await dispatchRenewalCycle(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.summary.candidatesProcessed).toBe(2);
    expect(result.value.summary.emailsSent).toBe(2);
    expect(result.value.summary.tasksCreated).toBe(0);
    expect(result.value.summary.failedTransient).toBe(0);
    expect(result.value.summary.failedPermanent).toBe(0);
  });

  it('multi-page cursor: paginates through 3 pages', async () => {
    const pages = [
      [buildCandidate('c-001')],
      [buildCandidate('c-002')],
      [buildCandidate('c-003')],
    ];
    (dispatchOneCycle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({ kind: 'sent', reminderEventId: 'r1', deliveryId: 'd1', dispatchedAt: NOW_ISO }),
    );
    const { deps, listMock } = fakeDeps(pages);
    const result = await dispatchRenewalCycle(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.summary.candidatesProcessed).toBe(3);
    expect(listMock).toHaveBeenCalledTimes(3);
  });

  it('aggregates skip counts by reason', async () => {
    const candidates = [
      buildCandidate('c-001'),
      buildCandidate('c-002'),
      buildCandidate('c-003'),
    ];
    let i = 0;
    (dispatchOneCycle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        i += 1;
        if (i === 1) return { kind: 'skipped', reason: 'member_archived' };
        if (i === 2) return { kind: 'skipped', reason: 'member_archived' };
        return { kind: 'skipped', reason: 'already_sent' };
      },
    );
    const { deps } = fakeDeps([candidates]);
    const result = await dispatchRenewalCycle(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.summary.skipped.member_archived).toBe(2);
    expect(result.value.summary.skipped.already_sent).toBe(1);
  });

  it('per-cycle exception is isolated: counted as failedTransient, loop continues', async () => {
    const candidates = [
      buildCandidate('c-001'),
      buildCandidate('c-002'),
    ];
    let i = 0;
    (dispatchOneCycle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        i += 1;
        if (i === 1) throw new Error('boom');
        return { kind: 'sent', reminderEventId: 'r1', deliveryId: 'd1', dispatchedAt: NOW_ISO };
      },
    );
    const { deps } = fakeDeps([candidates]);
    const result = await dispatchRenewalCycle(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.summary.candidatesProcessed).toBe(2);
    expect(result.value.summary.failedTransient).toBe(1);
    expect(result.value.summary.emailsSent).toBe(1);
  });

  it('failed_permanent + failed_transient counted separately', async () => {
    const candidates = [
      buildCandidate('c-001'),
      buildCandidate('c-002'),
      buildCandidate('c-003'),
    ];
    let i = 0;
    (dispatchOneCycle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        i += 1;
        if (i === 1)
          return { kind: 'failed_permanent', reminderEventId: 'r1', reason: '4xx' };
        if (i === 2)
          return { kind: 'failed_transient', reminderEventId: 'r2', reason: '5xx' };
        return { kind: 'task_created', taskId: 't1', taskType: 'phone_call', reminderEventId: 'r3' };
      },
    );
    const { deps } = fakeDeps([candidates]);
    const result = await dispatchRenewalCycle(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.summary.failedPermanent).toBe(1);
    expect(result.value.summary.failedTransient).toBe(1);
    expect(result.value.summary.tasksCreated).toBe(1);
  });

  it('default page size = 200 when omitted', async () => {
    const { deps, listMock } = fakeDeps([[]]);
    await dispatchRenewalCycle(deps, VALID_INPUT);
    expect(listMock.mock.calls[0]![1].pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('passes nowIso through to dispatchOneCycle ctx', async () => {
    const candidates = [buildCandidate('c-001')];
    const oneCycleMock = dispatchOneCycle as unknown as ReturnType<typeof vi.fn>;
    oneCycleMock.mockImplementation(async () => ({
      kind: 'sent',
      reminderEventId: 'r1',
      deliveryId: 'd1',
      dispatchedAt: NOW_ISO,
    }));
    const { deps } = fakeDeps([candidates]);
    await dispatchRenewalCycle(deps, VALID_INPUT);
    expect(oneCycleMock.mock.calls[0]![2].nowIso).toBe(NOW_ISO);
  });

  it('rejects empty tenantId with invalid_input', async () => {
    const { deps } = fakeDeps([[]]);
    const result = await dispatchRenewalCycle(deps, { ...VALID_INPUT, tenantId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('zero candidates: summary counters all zero', async () => {
    const { deps } = fakeDeps([[]]);
    const result = await dispatchRenewalCycle(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.summary.candidatesProcessed).toBe(0);
    expect(result.value.summary.emailsSent).toBe(0);
  });
});
