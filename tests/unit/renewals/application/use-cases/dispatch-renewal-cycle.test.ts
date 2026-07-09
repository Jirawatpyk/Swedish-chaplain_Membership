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

function fakeDeps(
  pages: ReadonlyArray<DispatchCandidate>[],
  opts: { unreconciledMemberIds?: ReadonlySet<string> } = {},
): {
  deps: RenewalsDeps;
  listMock: ReturnType<typeof vi.fn>;
  auditEmitMock: ReturnType<typeof vi.fn>;
  listUnreconciledMemberIdsMock: ReturnType<typeof vi.fn>;
} {
  let pageIdx = 0;
  const listMock = vi.fn(async () => {
    const items = pages[pageIdx] ?? [];
    pageIdx += 1;
    const hasMore = pageIdx < pages.length;
    return { items, nextCursor: hasMore ? `c-${pageIdx}` : null };
  });
  // K12-7 (TST-K-2): wire an audit-emitter mock so the K1-C8 outer-
  // catch `renewal_reminder_send_failed` emission path is testable.
  // Previously fakeDeps had no auditEmitter at all, so the outer
  // catch's audit emit was unobservable in unit tests.
  const auditEmitMock = vi.fn(async () => undefined);
  // FIX-6 (PR #173 review, 2026-07-09) — Gate 7.5's batched skip-set read.
  const listUnreconciledMemberIdsMock = vi.fn(
    async () => opts.unreconciledMemberIds ?? new Set<string>(),
  );
  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    dispatchCandidateRepo: { list: listMock, findOne: vi.fn() } as unknown as RenewalsDeps['dispatchCandidateRepo'],
    auditEmitter: { emit: auditEmitMock } as unknown as RenewalsDeps['auditEmitter'],
    memberRenewalFlagsRepo: {
      listMemberIdsWithUnreconciledPaidMembershipInvoice: listUnreconciledMemberIdsMock,
    } as unknown as RenewalsDeps['memberRenewalFlagsRepo'],
  } as unknown as RenewalsDeps;
  return { deps, listMock, auditEmitMock, listUnreconciledMemberIdsMock };
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

  it('K12-7 (TST-K-2): outer-catch per-cycle exception emits renewal_reminder_send_failed audit before synthetic failed_transient', async () => {
    // K1-C8 closed Constitution Principle VIII state↔audit atomicity
    // drift: when dispatchOneCycle throws (uncaught beyond its own
    // runInTenant boundary), the cron summary count was incremented to
    // failedTransient but no audit_log row was written. This test
    // pins the K1-C8 contract so a future refactor that drops the
    // audit emit (or re-orders past the synthetic Result) fails CI.
    const candidate = buildCandidate('c-007');
    (dispatchOneCycle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new Error('upstream went away');
      },
    );
    const { deps, auditEmitMock } = fakeDeps([[candidate]]);
    const result = await dispatchRenewalCycle(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.summary.failedTransient).toBe(1);

    // The audit emitter must have been called exactly once with the
    // canonical dispatcher_crash payload — failure_kind locks the
    // emit-site identity (vs the inline retry-pass emits which use
    // gateway_4xx / gateway_5xx / unsubscribed / etc.).
    expect(auditEmitMock).toHaveBeenCalledTimes(1);
    const emitCall = auditEmitMock.mock.calls[0]!;
    const event = emitCall[0] as {
      type: string;
      payload: {
        cycle_id: string;
        member_id: string;
        failure_kind: string;
        failure_message: string;
        via_retry_pass: boolean;
      };
    };
    expect(event.type).toBe('renewal_reminder_send_failed');
    expect(event.payload.cycle_id).toBe('c-007');
    expect(event.payload.failure_kind).toBe('dispatcher_crash');
    expect(event.payload.via_retry_pass).toBe(false);
    // The error message is forwarded (truncated to 200 chars upstream)
    // so on-call can correlate the audit row to the log line.
    expect(event.payload.failure_message).toContain('upstream went away');

    // Actor context: cron path (no human actor); correlationId
    // forwarded so the audit row joins the cron's log trail.
    const ctx = emitCall[1] as {
      tenantId: string;
      actorRole: string;
      actorUserId: string | null;
      correlationId: string;
      requestId: string | null;
    };
    expect(ctx.tenantId).toBe(TENANT_ID);
    expect(ctx.actorRole).toBe('cron');
    expect(ctx.actorUserId).toBeNull();
    expect(ctx.correlationId).toBe('corr-1');
    // K13-6 (TST-R12-1): pin requestId is null on cron path so a
    // future refactor that wires a non-null requestId here is caught.
    // The cron has no inbound HTTP request to forward correlation
    // from; the source-of-truth is correlationId.
    expect(ctx.requestId).toBeNull();
  });

  it('K12-7 (TST-K-2): audit-emit failure on outer-catch path does NOT throw (peer isolation invariant preserved)', async () => {
    // Ensures the inner try/catch around the audit emit (lines 308-
    // 324 of dispatch-renewal-cycle.ts) holds: if the audit emitter
    // itself throws (e.g. DB unreachable during catastrophic failure),
    // the loop must continue to the next candidate. Without this, an
    // audit-emit blip during an upstream outage cascades into total
    // cron failure.
    const candidates = [buildCandidate('c-008'), buildCandidate('c-009')];
    (dispatchOneCycle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new Error('upstream blip');
      },
    );
    const { deps, auditEmitMock } = fakeDeps([candidates]);
    auditEmitMock.mockImplementation(async () => {
      throw new Error('audit DB unreachable');
    });
    const result = await dispatchRenewalCycle(deps, VALID_INPUT);
    // Use-case still succeeds; both candidates counted.
    assertOk(result);
    expect(result.value.summary.candidatesProcessed).toBe(2);
    expect(result.value.summary.failedTransient).toBe(2);
    // Both audit emits attempted (peer isolation: emit-failure does
    // NOT short-circuit the next candidate's emit).
    expect(auditEmitMock).toHaveBeenCalledTimes(2);
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

  // FIX-6 (PR #173 review, 2026-07-09) — Gate 7.5's skip-set is read ONCE
  // per cron pass (not once per candidate/page) and threaded verbatim
  // into every dispatchOneCycle ctx.
  it('FIX-6: reads the unreconciled-member skip-set exactly ONCE across multiple pages and threads it into every ctx', async () => {
    const pages = [
      [buildCandidate('c-001')],
      [buildCandidate('c-002')],
      [buildCandidate('c-003')],
    ];
    const oneCycleMock = dispatchOneCycle as unknown as ReturnType<typeof vi.fn>;
    oneCycleMock.mockImplementation(async () => ({
      kind: 'sent',
      reminderEventId: 'r1',
      deliveryId: 'd1',
      dispatchedAt: NOW_ISO,
    }));
    const unreconciledMemberIds = new Set(['mem-unreconciled-1']);
    const { deps, listUnreconciledMemberIdsMock } = fakeDeps(pages, {
      unreconciledMemberIds,
    });
    const result = await dispatchRenewalCycle(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.summary.candidatesProcessed).toBe(3);
    // ONE read for the whole pass — not one per page (3 pages) or one per
    // candidate (3 candidates).
    expect(listUnreconciledMemberIdsMock).toHaveBeenCalledTimes(1);
    expect(listUnreconciledMemberIdsMock).toHaveBeenCalledWith(TENANT_ID);
    // Every candidate's ctx carries the SAME set reference.
    for (const call of oneCycleMock.mock.calls) {
      expect(call[2].unreconciledMemberIds).toBe(unreconciledMemberIds);
    }
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
