/**
 * F8 Phase 4 Wave I2d · T090 spec — `detectBounceThreshold` use-case.
 *
 * Target: 100% branch coverage (security-critical mutating path —
 * flips members.email_unverified flag that suppresses ALL future
 * reminders for the member).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { assertOk } from '../../_helpers/assert-result';
import {
  detectBounceThreshold,
  BOUNCE_THRESHOLD_HARD,
  BOUNCE_THRESHOLD_SOFT_IN_CYCLE,
  BOUNCE_THRESHOLD_SOFT_30D,
} from '@/modules/renewals/application/use-cases/detect-bounce-threshold';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';

const TENANT_ID = 'tenantA';
const MEMBER_ID = '00000000-0000-0000-0000-000000000aaa';
const CYCLE_ID = '00000000-0000-0000-0000-000000000c01';
const NOW_ISO = '2026-05-15T00:00:00.000Z';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

vi.mock('@/lib/env', () => ({
  env: {
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

function buildActiveCycle(): RenewalCycle {
  return {
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_ID),
    memberId: MEMBER_ID,
    status: 'upcoming' as const,
    periodFrom: '2026-05-01T00:00:00Z',
    periodTo: '2027-05-01T00:00:00Z',
    expiresAt: '2027-05-01T00:00:00Z',
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular' as const,
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB' as const,
    enteredPendingAt: null,
    linkedInvoiceId: null,
    linkedCreditNoteId: null,
    closedAt: null,
    closedReason: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  } as RenewalCycle;
}

function fakeDeps(opts: {
  activeCycle?: RenewalCycle | null;
  counts: {
    hardBounces: number;
    softBouncesInCycle: number | null;
    softBouncesIn30Days: number;
  };
  flagPreviouslyUnverified?: boolean;
  flagAffectedRows?: number;
  taskCreated?: boolean;
}): {
  deps: RenewalsDeps;
  setFlagMock: ReturnType<typeof vi.fn>;
  insertTaskMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  countBouncesMock: ReturnType<typeof vi.fn>;
} {
  const setFlagMock = vi.fn(async () => ({
    previouslyUnverified: opts.flagPreviouslyUnverified ?? false,
    affectedRows: opts.flagAffectedRows ?? 1,
  }));
  const insertTaskMock = vi.fn(async (_tx, input) => ({
    created: opts.taskCreated ?? true,
    row: {
      tenantId: TENANT_ID,
      taskId: input.taskId,
      memberId: input.memberId,
      cycleId: input.cycleId,
      taskType: input.taskType,
      assignedToRole: input.assignedToRole,
      assignedToUserId: null,
      dueAt: input.dueAt,
      relatedSuggestionId: null,
      createdAt: NOW_ISO,
      status: 'open' as const,
      outcomeNote: null,
      skippedReason: null,
      closedByUserId: null,
      closedAt: null,
    },
  }));
  const emitInTxMock = vi.fn(async () => {});
  const countBouncesMock = vi.fn(async () => opts.counts);
  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    cyclesRepo: {
      findActiveForMember: vi.fn(async () =>
        'activeCycle' in opts ? opts.activeCycle : buildActiveCycle(),
      ),
    } as unknown as RenewalsDeps['cyclesRepo'],
    bounceEventQuery: {
      countBounces: countBouncesMock,
    } as unknown as RenewalsDeps['bounceEventQuery'],
    memberRenewalFlagsRepo: {
      setEmailUnverified: setFlagMock,
      clearEmailUnverified: vi.fn(),
    } as unknown as RenewalsDeps['memberRenewalFlagsRepo'],
    escalationTaskRepo: {
      insertIfAbsent: insertTaskMock,
      findById: vi.fn(),
      list: vi.fn(),
      listOpenForUser: vi.fn(),
      listOpenForMemberByType: vi.fn(),
      transitionStatus: vi.fn(),
      reassign: vi.fn(),
    } as unknown as RenewalsDeps['escalationTaskRepo'],
    auditEmitter: {
      emit: vi.fn(),
      emitInTx: emitInTxMock,
    } as unknown as RenewalsDeps['auditEmitter'],
  } as unknown as RenewalsDeps;
  return { deps, setFlagMock, insertTaskMock, emitInTxMock, countBouncesMock };
}

const VALID_INPUT = {
  tenantId: TENANT_ID,
  memberId: MEMBER_ID,
  correlationId: 'corr-1',
  actorRole: 'webhook' as const,
  nowIso: NOW_ISO,
};

describe('detectBounceThreshold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('no threshold crossed', () => {
    it('zero bounces → no_threshold_crossed (no flag flip, no audit)', async () => {
      const { deps, setFlagMock, emitInTxMock } = fakeDeps({
        counts: { hardBounces: 0, softBouncesInCycle: 0, softBouncesIn30Days: 0 },
      });
      const result = await detectBounceThreshold(deps, VALID_INPUT);
      assertOk(result);
      expect(result.value.kind).toBe('no_threshold_crossed');
      expect(setFlagMock).not.toHaveBeenCalled();
      expect(emitInTxMock).not.toHaveBeenCalled();
    });

    it('soft-in-cycle = 2 (below 3 threshold) → no_threshold_crossed', async () => {
      const { deps } = fakeDeps({
        counts: {
          hardBounces: 0,
          softBouncesInCycle: BOUNCE_THRESHOLD_SOFT_IN_CYCLE - 1,
          softBouncesIn30Days: 2,
        },
      });
      const result = await detectBounceThreshold(deps, VALID_INPUT);
      assertOk(result);
      expect(result.value.kind).toBe('no_threshold_crossed');
    });

    it('soft-30d = 4 (below 5 threshold) → no_threshold_crossed', async () => {
      const { deps } = fakeDeps({
        counts: {
          hardBounces: 0,
          softBouncesInCycle: 0,
          softBouncesIn30Days: BOUNCE_THRESHOLD_SOFT_30D - 1,
        },
      });
      const result = await detectBounceThreshold(deps, VALID_INPUT);
      assertOk(result);
      expect(result.value.kind).toBe('no_threshold_crossed');
    });

    it('soft-in-cycle null (no active cycle) + soft-30d below 5 → no_threshold_crossed', async () => {
      const { deps } = fakeDeps({
        activeCycle: null,
        counts: { hardBounces: 0, softBouncesInCycle: null, softBouncesIn30Days: 4 },
      });
      const result = await detectBounceThreshold(deps, VALID_INPUT);
      assertOk(result);
      expect(result.value.kind).toBe('no_threshold_crossed');
    });
  });

  describe('threshold crossed', () => {
    it('hard bounce ≥1 → trigger=hard_bounce + flag flip + task + 2 audits', async () => {
      const { deps, setFlagMock, insertTaskMock, emitInTxMock } = fakeDeps({
        counts: { hardBounces: BOUNCE_THRESHOLD_HARD, softBouncesInCycle: 0, softBouncesIn30Days: 0 },
      });
      const result = await detectBounceThreshold(deps, VALID_INPUT);
      assertOk(result);
      expect(result.value.kind).toBe('threshold_crossed');
      if (result.value.kind !== 'threshold_crossed') return;
      expect(result.value.trigger).toBe('hard_bounce');
      expect(result.value.bounceCount).toBe(1);
      expect(setFlagMock).toHaveBeenCalledTimes(1);
      expect(insertTaskMock).toHaveBeenCalledTimes(1);
      expect(emitInTxMock).toHaveBeenCalledTimes(2);
      expect(emitInTxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'member_email_unverified_threshold_crossed' }),
        expect.anything(),
      );
      expect(emitInTxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'escalation_task_created' }),
        expect.anything(),
      );
    });

    it('soft-streak ≥3 in cycle → trigger=soft_streak', async () => {
      const { deps } = fakeDeps({
        counts: {
          hardBounces: 0,
          softBouncesInCycle: BOUNCE_THRESHOLD_SOFT_IN_CYCLE,
          softBouncesIn30Days: 3,
        },
      });
      const result = await detectBounceThreshold(deps, VALID_INPUT);
      assertOk(result);
      expect(result.value.kind).toBe('threshold_crossed');
      if (result.value.kind !== 'threshold_crossed') return;
      expect(result.value.trigger).toBe('soft_streak');
      expect(result.value.bounceCount).toBe(BOUNCE_THRESHOLD_SOFT_IN_CYCLE);
    });

    it('soft-rolling ≥5 in 30d → trigger=soft_rolling', async () => {
      const { deps } = fakeDeps({
        counts: {
          hardBounces: 0,
          softBouncesInCycle: 0,
          softBouncesIn30Days: BOUNCE_THRESHOLD_SOFT_30D,
        },
      });
      const result = await detectBounceThreshold(deps, VALID_INPUT);
      assertOk(result);
      expect(result.value.kind).toBe('threshold_crossed');
      if (result.value.kind !== 'threshold_crossed') return;
      expect(result.value.trigger).toBe('soft_rolling');
      expect(result.value.bounceCount).toBe(BOUNCE_THRESHOLD_SOFT_30D);
    });

    it('threshold ordering: hard before soft-streak even when both apply', async () => {
      const { deps } = fakeDeps({
        counts: {
          hardBounces: 1,
          softBouncesInCycle: 5,
          softBouncesIn30Days: 7,
        },
      });
      const result = await detectBounceThreshold(deps, VALID_INPUT);
      assertOk(result);
      expect(result.value.kind).toBe('threshold_crossed');
      if (result.value.kind !== 'threshold_crossed') return;
      expect(result.value.trigger).toBe('hard_bounce'); // hard wins
    });

    it('threshold ordering: soft-streak before soft-rolling when both apply', async () => {
      const { deps } = fakeDeps({
        counts: {
          hardBounces: 0,
          softBouncesInCycle: 3,
          softBouncesIn30Days: 6,
        },
      });
      const result = await detectBounceThreshold(deps, VALID_INPUT);
      assertOk(result);
      expect(result.value.kind).toBe('threshold_crossed');
      if (result.value.kind !== 'threshold_crossed') return;
      expect(result.value.trigger).toBe('soft_streak'); // streak wins
    });

    it('threshold-crossed audit payload carries all bounce counts + cycle_id', async () => {
      const { deps, emitInTxMock } = fakeDeps({
        counts: { hardBounces: 1, softBouncesInCycle: 0, softBouncesIn30Days: 0 },
      });
      await detectBounceThreshold(deps, VALID_INPUT);
      const audit = emitInTxMock.mock.calls.find(
        (c) => c[1].type === 'member_email_unverified_threshold_crossed',
      );
      expect(audit).toBeDefined();
      const payload = audit?.[1].payload as Record<string, unknown>;
      expect(payload.trigger).toBe('hard_bounce');
      expect(payload.hard_bounces).toBe(1);
      expect(payload.cycle_id).toBe(CYCLE_ID);
      expect(payload.escalation_task_created).toBe(true);
    });

    it('escalation_task_created audit NOT emitted when task already open (idempotent)', async () => {
      const { deps, emitInTxMock } = fakeDeps({
        counts: { hardBounces: 1, softBouncesInCycle: 0, softBouncesIn30Days: 0 },
        taskCreated: false,
      });
      await detectBounceThreshold(deps, VALID_INPUT);
      // Threshold-crossed audit is still emitted; task-created audit is NOT.
      const taskAudits = emitInTxMock.mock.calls.filter(
        (c) => c[1].type === 'escalation_task_created',
      );
      expect(taskAudits).toHaveLength(0);
      const thresholdAudits = emitInTxMock.mock.calls.filter(
        (c) => c[1].type === 'member_email_unverified_threshold_crossed',
      );
      expect(thresholdAudits).toHaveLength(1);
    });
  });

  describe('idempotent paths', () => {
    it('flag previously TRUE → already_unverified (no second flag flip, no audit)', async () => {
      const { deps, insertTaskMock, emitInTxMock } = fakeDeps({
        counts: { hardBounces: 5, softBouncesInCycle: 5, softBouncesIn30Days: 5 },
        flagPreviouslyUnverified: true,
      });
      const result = await detectBounceThreshold(deps, VALID_INPUT);
      assertOk(result);
      expect(result.value.kind).toBe('already_unverified');
      expect(insertTaskMock).not.toHaveBeenCalled();
      expect(emitInTxMock).not.toHaveBeenCalled();
    });

    it('J9-M4: member RLS-hidden (affectedRows=0) → member_not_found (distinct from already_unverified)', async () => {
      // Previously this case rolled up to `already_unverified` along
      // with the legitimate "flag-was-already-true" idempotent replay.
      // J9-M4 split the outcomes so operators can elevate the
      // member-not-found path to `logger.error` + alert (F1↔F8 desync
      // signal) without conflating it with normal idempotent traffic.
      const { deps, insertTaskMock, emitInTxMock } = fakeDeps({
        counts: { hardBounces: 1, softBouncesInCycle: 0, softBouncesIn30Days: 0 },
        flagAffectedRows: 0,
      });
      const result = await detectBounceThreshold(deps, VALID_INPUT);
      assertOk(result);
      expect(result.value.kind).toBe('member_not_found');
      expect(insertTaskMock).not.toHaveBeenCalled();
      expect(emitInTxMock).not.toHaveBeenCalled();
    });
  });

  describe('cycle resolution', () => {
    it('passes cycleStartedAt=null to bounceEventQuery when no active cycle', async () => {
      const { deps, countBouncesMock } = fakeDeps({
        activeCycle: null,
        counts: { hardBounces: 0, softBouncesInCycle: null, softBouncesIn30Days: 0 },
      });
      await detectBounceThreshold(deps, VALID_INPUT);
      expect(countBouncesMock).toHaveBeenCalledWith(
        TENANT_ID,
        MEMBER_ID,
        expect.objectContaining({ cycleStartedAt: null }),
      );
    });

    it('passes activeCycle.periodFrom to bounceEventQuery when cycle exists', async () => {
      const { deps, countBouncesMock } = fakeDeps({
        counts: { hardBounces: 0, softBouncesInCycle: 0, softBouncesIn30Days: 0 },
      });
      await detectBounceThreshold(deps, VALID_INPUT);
      expect(countBouncesMock).toHaveBeenCalledWith(
        TENANT_ID,
        MEMBER_ID,
        expect.objectContaining({ cycleStartedAt: '2026-05-01T00:00:00Z' }),
      );
    });

    it('cycle_id null in audit payload when no active cycle', async () => {
      const { deps, emitInTxMock } = fakeDeps({
        activeCycle: null,
        counts: { hardBounces: 1, softBouncesInCycle: null, softBouncesIn30Days: 0 },
      });
      await detectBounceThreshold(deps, VALID_INPUT);
      const audit = emitInTxMock.mock.calls.find(
        (c) => c[1].type === 'member_email_unverified_threshold_crossed',
      );
      expect((audit?.[1].payload as Record<string, unknown>).cycle_id).toBe(null);
    });
  });

  describe('input validation', () => {
    it('rejects empty tenantId', async () => {
      const { deps } = fakeDeps({
        counts: { hardBounces: 0, softBouncesInCycle: 0, softBouncesIn30Days: 0 },
      });
      const result = await detectBounceThreshold(deps, { ...VALID_INPUT, tenantId: '' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('invalid_input');
    });

    it('rejects non-UUID memberId', async () => {
      const { deps } = fakeDeps({
        counts: { hardBounces: 0, softBouncesInCycle: 0, softBouncesIn30Days: 0 },
      });
      const result = await detectBounceThreshold(deps, {
        ...VALID_INPUT,
        memberId: 'not-a-uuid',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('invalid_input');
    });

    it('rejects unknown actorRole', async () => {
      const { deps } = fakeDeps({
        counts: { hardBounces: 0, softBouncesInCycle: 0, softBouncesIn30Days: 0 },
      });
      const result = await detectBounceThreshold(deps, {
        ...VALID_INPUT,
        actorRole: 'admin' as never,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('invalid_input');
    });
  });

  it('threshold constants match FR-012a canonical values', () => {
    expect(BOUNCE_THRESHOLD_HARD).toBe(1);
    expect(BOUNCE_THRESHOLD_SOFT_IN_CYCLE).toBe(3);
    expect(BOUNCE_THRESHOLD_SOFT_30D).toBe(5);
  });
});
