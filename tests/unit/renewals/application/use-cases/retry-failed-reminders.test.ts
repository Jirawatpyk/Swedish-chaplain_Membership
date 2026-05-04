/**
 * F8 Phase 4 Wave I2e spec — `retryFailedReminders` use-case (FR-010a).
 *
 * Two-pass retry budget orchestrator:
 *   - Pass 1 — re-attempt eligible failures within the 24h window
 *   - Pass 2 — mark exhausted budgets permanent + create escalation task
 *
 * Test scope: per-event outcome propagation + summary aggregation +
 * fault isolation.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { retryFailedReminders } from '@/modules/renewals/application/use-cases/retry-failed-reminders';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { ReminderEvent } from '@/modules/renewals/application/ports/renewal-reminder-event-repo';
import type { DispatchCandidate } from '@/modules/renewals/application/ports/dispatch-candidate-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { ok, err } from '@/lib/result';

const TENANT_ID = 'tenantA';
const NOW_ISO = '2026-05-15T12:00:00.000Z';
const CYCLE_ID = '00000000-0000-0000-0000-000000000c01';
const MEMBER_ID = '00000000-0000-0000-0000-000000000aaa';
const REMINDER_EVENT_ID = '00000000-0000-0000-0000-000000000eef';

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

function buildFailedEvent(
  overrides: Partial<ReminderEvent> = {},
): ReminderEvent {
  return {
    tenantId: TENANT_ID,
    reminderEventId: REMINDER_EVENT_ID,
    cycleId: CYCLE_ID,
    stepId: 't-30.email',
    channel: 'email' as const,
    templateId: 'renewal.t-30.regular',
    taskType: null,
    dispatchedAt: '2026-05-14T10:00:00.000Z',
    deliveryId: null,
    status: 'failed' as const,
    skipReason: null,
    failureReason: 'upstream_unavailable',
    actorUserId: null,
    yearInCycle: 1,
    createdAt: '2026-05-14T10:00:00.000Z',
    retryUntil: '2026-05-15T22:00:00.000Z', // 22:00 = 12 + 10 hours from now=12:00
    retryExhaustedAt: null,
    ...overrides,
  };
}

function buildHappyCandidate(): DispatchCandidate {
  return {
    cycle: {
      tenantId: TENANT_ID,
      cycleId: asCycleId(CYCLE_ID),
      memberId: MEMBER_ID,
      status: 'awaiting_payment' as const,
      periodFrom: '2026-05-01T00:00:00Z',
      periodTo: '2027-05-01T00:00:00Z',
      expiresAt: '2026-06-14T00:00:00Z',
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
    },
    member: {
      memberId: MEMBER_ID,
      status: 'active',
      companyName: 'Acme',
      preferredLocale: 'en',
      emailUnverified: false,
      renewalRemindersOptedOut: false,
      registrationDate: '2024-01-01',
    },
    primaryContact: {
      contactId: 'c1',
      email: 'a@b.co',
      firstName: 'A',
      lastName: 'B',
      preferredLanguage: 'en',
    },
    schedulePolicy: null,
  };
}

function fakeDeps(opts: {
  eligible?: ReadonlyArray<ReminderEvent>;
  exhausted?: ReadonlyArray<ReminderEvent>;
  candidate?: DispatchCandidate | null;
  gatewayResult?: ReturnType<typeof ok> | ReturnType<typeof err>;
  insertTaskCreated?: boolean;
  transitionFailedToSentImpl?: () => Promise<ReminderEvent>;
}): {
  deps: RenewalsDeps;
  emitInTxMock: ReturnType<typeof vi.fn>;
  markExhaustedMock: ReturnType<typeof vi.fn>;
  transitionFailedToSentMock: ReturnType<typeof vi.fn>;
  insertTaskMock: ReturnType<typeof vi.fn>;
  gatewayMock: ReturnType<typeof vi.fn>;
} {
  const emitInTxMock = vi.fn(async () => {});
  const markExhaustedMock = vi.fn(async (_tx, input) => ({
    ...buildFailedEvent({ reminderEventId: input.reminderEventId }),
    retryExhaustedAt: input.exhaustedAtIso,
  }));
  const transitionFailedToSentMock = vi.fn(
    opts.transitionFailedToSentImpl ??
      (async () =>
        buildFailedEvent({ status: 'sent' as const, retryUntil: null })),
  );
  const insertTaskMock = vi.fn(async (_tx, input) => ({
    created: opts.insertTaskCreated ?? true,
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
  const gatewayMock = vi.fn(
    async () => opts.gatewayResult ?? ok({ deliveryId: 'retry-d1', dispatchedAt: NOW_ISO }),
  );

  const candidate =
    'candidate' in opts ? opts.candidate : buildHappyCandidate();

  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    reminderEventRepo: {
      insertIfAbsent: vi.fn(),
      transitionStatus: vi.fn(),
      transitionFailedToSent: transitionFailedToSentMock,
      listForCycle: vi.fn(),
      listFailedSince: vi.fn(),
      listRetryEligible: vi.fn(async () => opts.eligible ?? []),
      listRetryExhausted: vi.fn(async () => opts.exhausted ?? []),
      markRetryExhausted: markExhaustedMock,
    } as unknown as RenewalsDeps['reminderEventRepo'],
    dispatchCandidateRepo: {
      list: vi.fn(),
      findOne: vi.fn(async () => candidate),
    } as unknown as RenewalsDeps['dispatchCandidateRepo'],
    renewalGateway: {
      sendRenewalEmail: gatewayMock,
    } as unknown as RenewalsDeps['renewalGateway'],
    escalationTaskRepo: {
      insertIfAbsent: insertTaskMock,
    } as unknown as RenewalsDeps['escalationTaskRepo'],
    auditEmitter: {
      emit: vi.fn(),
      emitInTx: emitInTxMock,
    } as unknown as RenewalsDeps['auditEmitter'],
  } as unknown as RenewalsDeps;
  return {
    deps,
    emitInTxMock,
    markExhaustedMock,
    transitionFailedToSentMock,
    insertTaskMock,
    gatewayMock,
  };
}

const VALID_INPUT = {
  tenantId: TENANT_ID,
  correlationId: 'corr-1',
  nowIso: NOW_ISO,
};

describe('retryFailedReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Pass 1 — eligible retries', () => {
    it('zero eligible: summary all-zero, gateway never called', async () => {
      const { deps, gatewayMock } = fakeDeps({});
      const result = await retryFailedReminders(deps, VALID_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.retryEligibleProcessed).toBe(0);
      expect(gatewayMock).not.toHaveBeenCalled();
    });

    it('successful retry: flips status failed→sent + emits 2 audits', async () => {
      const { deps, emitInTxMock, transitionFailedToSentMock, markExhaustedMock } = fakeDeps({
        eligible: [buildFailedEvent()],
      });
      const result = await retryFailedReminders(deps, VALID_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.retrySucceeded).toBe(1);
      // Wave I2e G1+E1 fixes: status flip via dedicated method; no
      // semantic-abuse of markRetryExhausted on success path.
      expect(transitionFailedToSentMock).toHaveBeenCalledTimes(1);
      expect(markExhaustedMock).not.toHaveBeenCalled();
      // Audits: renewal_reminder_retried + renewal_reminder_sent.
      expect(emitInTxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'renewal_reminder_retried' }),
        expect.anything(),
      );
      expect(emitInTxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'renewal_reminder_sent' }),
        expect.anything(),
      );
    });

    it('successful retry race: concurrent winner already flipped → idempotent succeeded outcome', async () => {
      const { deps, transitionFailedToSentMock } = fakeDeps({
        eligible: [buildFailedEvent()],
        transitionFailedToSentImpl: async () => {
          // Simulate concurrent retry pass winning the race.
          throw new Error('reminder event not found (concurrent winner)');
        },
      });
      const result = await retryFailedReminders(deps, VALID_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Idempotent — counted as succeeded even though THIS pass didn't
      // actually flip the row (the concurrent winner did).
      expect(result.value.summary.retrySucceeded).toBe(1);
      expect(transitionFailedToSentMock).toHaveBeenCalledTimes(1);
    });

    it('still-transient: counted as still_transient, retry_until preserved', async () => {
      const { deps, emitInTxMock, markExhaustedMock } = fakeDeps({
        eligible: [buildFailedEvent()],
        gatewayResult: err({ kind: 'gateway_5xx' as const, retryable: true, message: 'timeout' }),
      });
      const result = await retryFailedReminders(deps, VALID_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.retryStillTransient).toBe(1);
      expect(markExhaustedMock).not.toHaveBeenCalled();
      expect(emitInTxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: 'renewal_reminder_retried',
          payload: expect.objectContaining({ attempt_outcome: 'still_transient' }),
        }),
        expect.anything(),
      );
    });

    it('became permanent during retry: emits permanent + creates task', async () => {
      const { deps, emitInTxMock, insertTaskMock, markExhaustedMock } = fakeDeps({
        eligible: [buildFailedEvent()],
        gatewayResult: err({
          kind: 'recipient_unsubscribed' as const,
        }),
      });
      const result = await retryFailedReminders(deps, VALID_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.retryBecamePermanent).toBe(1);
      expect(insertTaskMock).toHaveBeenCalledTimes(1);
      expect(markExhaustedMock).toHaveBeenCalledTimes(1);
      const permanentAudit = emitInTxMock.mock.calls.find(
        (c) => c[1].type === 'renewal_reminder_send_failed_permanent',
      );
      expect(permanentAudit).toBeDefined();
    });

    it('member archived between failure and retry: blocked_by_gate', async () => {
      const candidate = buildHappyCandidate();
      const { deps, gatewayMock } = fakeDeps({
        eligible: [buildFailedEvent()],
        candidate: {
          ...candidate,
          member: { ...candidate.member, status: 'archived' },
        },
      });
      const result = await retryFailedReminders(deps, VALID_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.retryBlockedByGate).toBe(1);
      expect(gatewayMock).not.toHaveBeenCalled();
    });

    it('candidate not found (cycle deleted/RLS): blocked_by_gate', async () => {
      const { deps, gatewayMock } = fakeDeps({
        eligible: [buildFailedEvent()],
        candidate: null,
      });
      const result = await retryFailedReminders(deps, VALID_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.retryBlockedByGate).toBe(1);
      expect(gatewayMock).not.toHaveBeenCalled();
    });

    it('per-event exception isolated: counted as passErrors, loop continues', async () => {
      // Two eligible events; gateway throws for first, succeeds for second.
      const { deps } = fakeDeps({
        eligible: [
          buildFailedEvent({ reminderEventId: 'event-1' }),
          buildFailedEvent({ reminderEventId: 'event-2' }),
        ],
      });
      const gateway = deps.renewalGateway as { sendRenewalEmail: ReturnType<typeof vi.fn> };
      let i = 0;
      gateway.sendRenewalEmail = vi.fn(async () => {
        i += 1;
        if (i === 1) throw new Error('boom');
        return ok({ deliveryId: 'd2', dispatchedAt: NOW_ISO });
      });
      const result = await retryFailedReminders(deps, VALID_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.passErrors).toBe(1);
      expect(result.value.summary.retrySucceeded).toBe(1);
    });
  });

  describe('Pass 2 — exhausted budgets', () => {
    it('exhausted event: emits permanent audit + creates task + marks exhausted', async () => {
      const { deps, emitInTxMock, insertTaskMock, markExhaustedMock } = fakeDeps({
        exhausted: [buildFailedEvent({ retryUntil: '2026-05-15T06:00:00Z' })],
      });
      const result = await retryFailedReminders(deps, VALID_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.exhaustedMarked).toBe(1);
      expect(insertTaskMock).toHaveBeenCalledTimes(1);
      expect(markExhaustedMock).toHaveBeenCalledTimes(1);
      const permanentAudit = emitInTxMock.mock.calls.find(
        (c) => c[1].type === 'renewal_reminder_send_failed_permanent',
      );
      expect(permanentAudit).toBeDefined();
    });

    it('exhausted event with already-open task: no second task audit', async () => {
      const { deps, emitInTxMock } = fakeDeps({
        exhausted: [buildFailedEvent({ retryUntil: '2026-05-15T06:00:00Z' })],
        insertTaskCreated: false,
      });
      await retryFailedReminders(deps, VALID_INPUT);
      const taskAudits = emitInTxMock.mock.calls.filter(
        (c) => c[1].type === 'escalation_task_created',
      );
      expect(taskAudits).toHaveLength(0);
      // Permanent audit still emitted.
      const permanentAudits = emitInTxMock.mock.calls.filter(
        (c) => c[1].type === 'renewal_reminder_send_failed_permanent',
      );
      expect(permanentAudits).toHaveLength(1);
    });

    it('exhausted with candidate not found: emits permanent audit (no task)', async () => {
      const { deps, emitInTxMock, insertTaskMock } = fakeDeps({
        exhausted: [buildFailedEvent()],
        candidate: null,
      });
      const result = await retryFailedReminders(deps, VALID_INPUT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.exhaustedMarked).toBe(1);
      expect(insertTaskMock).not.toHaveBeenCalled();
      const permanentAudit = emitInTxMock.mock.calls.find(
        (c) => c[1].type === 'renewal_reminder_send_failed_permanent',
      );
      expect(permanentAudit).toBeDefined();
    });
  });

  describe('input validation', () => {
    it('rejects empty tenantId', async () => {
      const { deps } = fakeDeps({});
      const result = await retryFailedReminders(deps, { ...VALID_INPUT, tenantId: '' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('invalid_input');
    });

    it('rejects invalid nowIso datetime', async () => {
      const { deps } = fakeDeps({});
      const result = await retryFailedReminders(deps, { ...VALID_INPUT, nowIso: 'not-a-date' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('invalid_input');
    });
  });

  it('summary durationMs is non-negative', async () => {
    const { deps } = fakeDeps({});
    const result = await retryFailedReminders(deps, VALID_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary.durationMs).toBeGreaterThanOrEqual(0);
  });
});
