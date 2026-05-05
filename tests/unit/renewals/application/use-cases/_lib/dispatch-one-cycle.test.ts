/**
 * F8 Phase 4 Wave I2c · core spec — `dispatchOneCycle`.
 *
 * Target: 100% branch coverage on the 12-gate decision tree
 * (security-critical mutating path per Constitution coverage table).
 *
 * Test fixture pattern: `buildHappyCandidate()` returns a candidate
 * that passes ALL 12 gates → expected outcome is `sent` for email
 * channel; per-test override of single field exercises one specific
 * gate.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  dispatchOneCycle,
  computeYearInCycle,
  computeCycleYears,
  type DispatchContext,
} from '@/modules/renewals/application/use-cases/_lib/dispatch-one-cycle';
import type { DispatchCandidate } from '@/modules/renewals/application/ports/dispatch-candidate-repo';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { ok, err } from '@/lib/result';

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
    features: { f8Renewals: true },
    flags: { readOnlyMode: false },
    log: { level: 'silent' },
    app: { baseUrl: 'http://localhost:3100' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return {
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_ID),
    memberId: MEMBER_ID,
    status: 'upcoming' as const,
    periodFrom: '2026-05-15T00:00:00.000Z',
    periodTo: '2027-05-15T00:00:00.000Z',
    expiresAt: '2026-06-14T00:00:00.000Z', // T-30 from NOW_ISO
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
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  } as RenewalCycle;
}

function buildHappyCandidate(
  overrides: Partial<{
    cycle: Partial<RenewalCycle>;
    member: Partial<DispatchCandidate['member']>;
    primaryContact: DispatchCandidate['primaryContact'];
    schedulePolicy: DispatchCandidate['schedulePolicy'];
  }> = {},
): DispatchCandidate {
  return {
    cycle: buildCycle(overrides.cycle ?? {}),
    member: {
      memberId: MEMBER_ID,
      status: 'active',
      companyName: 'Acme Co',
      preferredLocale: 'en',
      emailUnverified: false,
      renewalRemindersOptedOut: false,
      registrationDate: '2024-01-01',
      ...(overrides.member ?? {}),
    },
    primaryContact:
      overrides.primaryContact === undefined
        ? {
            contactId: 'contact-1',
            email: 'admin@acme.com',
            firstName: 'Anna',
            lastName: 'Adm',
            preferredLanguage: 'en',
          }
        : overrides.primaryContact,
    schedulePolicy:
      overrides.schedulePolicy === undefined
        ? {
            tenantId: TENANT_ID,
            tierBucket: 'regular' as const,
            steps: [
              {
                stepId: 't-30.email',
                offsetDays: -30,
                channel: 'email' as const,
                templateId: 'renewal.t-30.regular',
              },
            ],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-04-01T00:00:00Z',
          }
        : overrides.schedulePolicy,
  };
}

function fakeDeps(opts: {
  pauseResult?: { paused: boolean; latestOutreachAt?: string };
  insertReminderCreated?: boolean;
  gatewayResult?: ReturnType<typeof ok> | ReturnType<typeof err>;
  insertTaskCreated?: boolean;
}): {
  deps: RenewalsDeps;
  emitMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  insertReminderMock: ReturnType<typeof vi.fn>;
  transitionReminderMock: ReturnType<typeof vi.fn>;
  insertTaskMock: ReturnType<typeof vi.fn>;
  gatewayMock: ReturnType<typeof vi.fn>;
  pauseRepoMock: ReturnType<typeof vi.fn>;
} {
  const emitMock = vi.fn(async () => {});
  const emitInTxMock = vi.fn(async () => {});
  const insertReminderMock = vi.fn(async (_tx, input) => ({
    created: opts.insertReminderCreated ?? true,
    row: {
      tenantId: TENANT_ID,
      reminderEventId: 'rem-1',
      cycleId: CYCLE_ID,
      stepId: input.stepId,
      channel: input.channel,
      templateId: input.templateId ?? null,
      taskType: input.taskType ?? null,
      dispatchedAt: opts.insertReminderCreated === false ? '2026-05-14T00:00:00Z' : null,
      deliveryId: null,
      status: 'pending' as const,
      skipReason: null,
      failureReason: null,
      actorUserId: null,
      yearInCycle: input.yearInCycle,
      createdAt: NOW_ISO,
    },
  }));
  const transitionReminderMock = vi.fn(async () => ({
    tenantId: TENANT_ID,
    reminderEventId: 'rem-1',
    cycleId: CYCLE_ID,
    stepId: 't-30.email',
    channel: 'email' as const,
    templateId: 'renewal.t-30.regular',
    taskType: null,
    dispatchedAt: NOW_ISO,
    deliveryId: 'stub-delivery-1',
    status: 'sent' as const,
    skipReason: null,
    failureReason: null,
    actorUserId: null,
    yearInCycle: 1,
    createdAt: NOW_ISO,
  }));
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
  const defaultGatewayResult = ok({
    deliveryId: 'stub-delivery-1',
    dispatchedAt: NOW_ISO,
  });
  const gatewayMock = vi.fn(async () => opts.gatewayResult ?? defaultGatewayResult);
  const pauseRepoMock = vi.fn(async () => ({
    hasOutreach: opts.pauseResult?.paused ?? false,
    latestAt: opts.pauseResult?.paused
      ? opts.pauseResult.latestOutreachAt ?? '2026-05-12T00:00:00Z'
      : null,
  }));

  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    auditEmitter: {
      emit: emitMock,
      emitInTx: emitInTxMock,
    } as unknown as RenewalsDeps['auditEmitter'],
    reminderEventRepo: {
      insertIfAbsent: insertReminderMock,
      transitionStatus: transitionReminderMock,
      listForCycle: vi.fn(),
      listFailedSince: vi.fn(),
    } as unknown as RenewalsDeps['reminderEventRepo'],
    escalationTaskRepo: {
      insertIfAbsent: insertTaskMock,
      findById: vi.fn(),
      list: vi.fn(),
      listOpenForUser: vi.fn(),
      listOpenForMemberByType: vi.fn(),
      transitionStatus: vi.fn(),
      reassign: vi.fn(),
    } as unknown as RenewalsDeps['escalationTaskRepo'],
    renewalGateway: {
      sendRenewalEmail: gatewayMock,
    } as unknown as RenewalsDeps['renewalGateway'],
    atRiskOutreachReadRepo: {
      hasOutreachWithinDays: pauseRepoMock,
    } as unknown as RenewalsDeps['atRiskOutreachReadRepo'],
  } as unknown as RenewalsDeps;

  return {
    deps,
    emitMock,
    emitInTxMock,
    insertReminderMock,
    transitionReminderMock,
    insertTaskMock,
    gatewayMock,
    pauseRepoMock,
  };
}

const happyCtx: DispatchContext = {
  tenantId: TENANT_ID,
  actorUserId: null,
  actorRole: 'cron',
  correlationId: 'corr-1',
  requestId: null,
  nowIso: NOW_ISO,
};

describe('dispatchOneCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy paths', () => {
    it('email channel: success → outcome=sent + audit renewal_reminder_sent', async () => {
      const { deps, gatewayMock, transitionReminderMock, emitInTxMock } = fakeDeps({});
      const result = await dispatchOneCycle(deps, buildHappyCandidate(), happyCtx);
      expect(result.kind).toBe('sent');
      if (result.kind !== 'sent') return;
      expect(result.deliveryId).toBe('stub-delivery-1');
      expect(gatewayMock).toHaveBeenCalledTimes(1);
      expect(transitionReminderMock).toHaveBeenCalledTimes(1);
      expect(emitInTxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'renewal_reminder_sent' }),
        expect.anything(),
      );
    });

    it('task channel: outcome=task_created + audit escalation_task_created', async () => {
      const { deps, insertTaskMock, emitInTxMock } = fakeDeps({});
      const candidate = buildHappyCandidate({
        schedulePolicy: {
          tenantId: TENANT_ID,
          tierBucket: 'partnership' as const,
          steps: [
            {
              stepId: 't-30.task',
              offsetDays: -30,
              channel: 'task' as const,
              taskType: 'phone_call',
              assigneeRole: 'admin' as const,
            },
          ],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-04-01T00:00:00Z',
        },
      });
      const result = await dispatchOneCycle(deps, candidate, happyCtx);
      expect(result.kind).toBe('task_created');
      expect(insertTaskMock).toHaveBeenCalledTimes(1);
      const auditCall = emitInTxMock.mock.calls.find(
        (c) => c[1].type === 'escalation_task_created',
      );
      expect(auditCall).toBeDefined();
    });
  });

  describe('skip gates', () => {
    it('Gate 3 — cycle terminal (cancelled): skip cycle_terminal', async () => {
      const { deps, emitMock } = fakeDeps({});
      const result = await dispatchOneCycle(
        deps,
        buildHappyCandidate({ cycle: { status: 'cancelled' as const, closedAt: NOW_ISO, closedReason: 'cancelled' as const, closedByUserId: null } as Partial<RenewalCycle> }),
        happyCtx,
      );
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('cycle_terminal');
      expect(emitMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'renewal_reminder_skipped' }),
        expect.anything(),
      );
    });

    it('Gate 4 — member archived: skip member_archived', async () => {
      const { deps, emitMock } = fakeDeps({});
      const result = await dispatchOneCycle(
        deps,
        buildHappyCandidate({ member: { status: 'archived' as const } }),
        happyCtx,
      );
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('member_archived');
      expect(emitMock.mock.calls[0]![0].payload.reason).toBe('member_archived');
    });

    it('Gate 4.5 — empty registrationDate: skip no_joined_at + emit renewal_skipped_no_joined_at', async () => {
      const { deps, emitMock } = fakeDeps({});
      const result = await dispatchOneCycle(
        deps,
        buildHappyCandidate({ member: { registrationDate: '' } }),
        happyCtx,
      );
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('no_joined_at');
      // T106 dedicated audit type — NOT the generic renewal_reminder_skipped.
      expect(emitMock).toHaveBeenCalledTimes(1);
      expect(emitMock.mock.calls[0]![0].type).toBe('renewal_skipped_no_joined_at');
    });

    it('Gate 5 — member opted out: skip member_opted_out', async () => {
      const { deps } = fakeDeps({});
      const result = await dispatchOneCycle(
        deps,
        buildHappyCandidate({ member: { renewalRemindersOptedOut: true } }),
        happyCtx,
      );
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('member_opted_out');
    });

    it('Gate 6 — email unverified: skip email_unverified', async () => {
      const { deps } = fakeDeps({});
      const result = await dispatchOneCycle(
        deps,
        buildHappyCandidate({ member: { emailUnverified: true } }),
        happyCtx,
      );
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('email_unverified');
    });

    it('Gate 7 — no schedule policy: skip tenant_misconfigured', async () => {
      const { deps } = fakeDeps({});
      const result = await dispatchOneCycle(
        deps,
        buildHappyCandidate({ schedulePolicy: null }),
        happyCtx,
      );
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('tenant_misconfigured');
    });

    it('Gate 8 — step not due today: silent skip not_due_today (no audit)', async () => {
      const { deps, emitMock, emitInTxMock } = fakeDeps({});
      // expires_at = today + 90 → no T-30 step matches today
      const result = await dispatchOneCycle(
        deps,
        buildHappyCandidate({
          cycle: { expiresAt: '2026-08-13T00:00:00.000Z' } as Partial<RenewalCycle>,
        }),
        happyCtx,
      );
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('not_due_today');
      // No audit emit for not_due_today (too noisy).
      expect(emitMock).not.toHaveBeenCalled();
      expect(emitInTxMock).not.toHaveBeenCalled();
    });

    it('Gate 9 — multi-year non-final-year: skip multi_year_non_final_year', async () => {
      const { deps } = fakeDeps({});
      // 3-year cycle, period_from = today, expires_at = T-30 from now
      // → year_in_cycle = 1, cycleYears = 3 → NOT final year
      const result = await dispatchOneCycle(
        deps,
        buildHappyCandidate({
          cycle: {
            cycleLengthMonths: 36,
            periodFrom: '2026-05-15T00:00:00.000Z',
            expiresAt: '2026-06-14T00:00:00.000Z',
          },
        }),
        happyCtx,
      );
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('multi_year_non_final_year');
    });

    it('Gate 10 — outreach pause active: skip outreach_in_progress', async () => {
      const { deps } = fakeDeps({
        pauseResult: { paused: true, latestOutreachAt: '2026-05-12T00:00:00Z' },
      });
      const result = await dispatchOneCycle(deps, buildHappyCandidate(), happyCtx);
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('outreach_in_progress');
      expect(result.metadata?.latest_outreach_at).toBe('2026-05-12T00:00:00Z');
    });

    it('J2-B6: Gate 10 — pause-check returns err Result → defensive skip tenant_misconfigured (NOT silent fall-through)', async () => {
      // Force pauseRemindersAfterOutreach Zod input rejection by
      // passing a non-UUID memberId. Previously the dispatcher silently
      // fell through and dispatched the email, violating FR-033's
      // "system reminder must not collide with logged outreach"
      // invariant. Defensive skip preserves the FR contract.
      const { deps, emitMock, gatewayMock } = fakeDeps({});
      const candidate = buildHappyCandidate({
        member: {
          memberId: 'not-a-uuid', // Zod rejects → pauseResult.ok=false
        },
      });
      const result = await dispatchOneCycle(deps, candidate, happyCtx);
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('tenant_misconfigured');
      // Gateway MUST NOT be called — that's the FR-033 violation we
      // are preventing.
      expect(gatewayMock).not.toHaveBeenCalled();
      // Audit emit carries the gate metadata so ops can triage which
      // gate failed.
      expect(emitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'renewal_reminder_skipped',
          payload: expect.objectContaining({
            reason: 'tenant_misconfigured',
            gate: 'outreach_pause_check',
          }),
        }),
        expect.anything(),
      );
    });

    it('Gate 11 — email step + no primary contact: skip no_primary_contact + create task', async () => {
      const { deps, insertTaskMock, emitInTxMock } = fakeDeps({});
      const result = await dispatchOneCycle(
        deps,
        buildHappyCandidate({ primaryContact: null }),
        happyCtx,
      );
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('no_primary_contact');
      expect(insertTaskMock).toHaveBeenCalledTimes(1);
      expect(insertTaskMock.mock.calls[0]![1].taskType).toBe(
        'manual_outreach_required',
      );
      // Both audits emitted: escalation_task_created + renewal_reminder_skipped.
      expect(emitInTxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'escalation_task_created' }),
        expect.anything(),
      );
      expect(emitInTxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'renewal_reminder_skipped' }),
        expect.anything(),
      );
    });

    it('Gate 12 — idempotency replay: skip already_sent (no audit, no gateway)', async () => {
      const { deps, gatewayMock, emitInTxMock } = fakeDeps({
        insertReminderCreated: false,
      });
      const result = await dispatchOneCycle(deps, buildHappyCandidate(), happyCtx);
      expect(result.kind).toBe('skipped');
      if (result.kind !== 'skipped') return;
      expect(result.reason).toBe('already_sent');
      expect(gatewayMock).not.toHaveBeenCalled();
      expect(emitInTxMock).not.toHaveBeenCalled();
    });
  });

  describe('failure paths', () => {
    it('gateway 4xx (permanent): outcome=failed_permanent + audit', async () => {
      const { deps, emitInTxMock } = fakeDeps({
        gatewayResult: err({
          kind: 'gateway_4xx' as const,
          retryable: false,
          message: 'invalid recipient',
        }),
      });
      const result = await dispatchOneCycle(deps, buildHappyCandidate(), happyCtx);
      expect(result.kind).toBe('failed_permanent');
      expect(emitInTxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'renewal_reminder_send_failed_permanent' }),
        expect.anything(),
      );
    });

    it('gateway 5xx (transient): outcome=failed_transient + audit', async () => {
      const { deps, emitInTxMock } = fakeDeps({
        gatewayResult: err({
          kind: 'gateway_5xx' as const,
          retryable: true,
          message: 'upstream timeout',
        }),
      });
      const result = await dispatchOneCycle(deps, buildHappyCandidate(), happyCtx);
      expect(result.kind).toBe('failed_transient');
      expect(emitInTxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'renewal_reminder_send_failed' }),
        expect.anything(),
      );
    });

    it('gateway recipient_unsubscribed: outcome=failed_permanent', async () => {
      const { deps } = fakeDeps({
        gatewayResult: err({ kind: 'recipient_unsubscribed' as const }),
      });
      const result = await dispatchOneCycle(deps, buildHappyCandidate(), happyCtx);
      expect(result.kind).toBe('failed_permanent');
    });

    it('J2-B2: gateway throws uncaught → row defensively transitioned to failed for retry pickup (no orphan pending row)', async () => {
      const { deps, transitionReminderMock, emitInTxMock } = fakeDeps({});
      // Override gateway to throw exception (NOT return err Result)
      // — simulates network panic, SDK crash, or any uncaught throw
      // between insertIfAbsent (row=pending) and transitionStatus.
      const gateway = deps.renewalGateway as {
        sendRenewalEmail: ReturnType<typeof vi.fn>;
      };
      gateway.sendRenewalEmail = vi.fn(async () => {
        throw new Error('SDK panic: ECONNRESET');
      });

      const result = await dispatchOneCycle(deps, buildHappyCandidate(), happyCtx);

      // Outcome: failed_transient with dispatcher_crash reason — caller
      // (cron) tallies this as a transient failure, allowing retry-pass
      // pickup within 24h.
      expect(result.kind).toBe('failed_transient');
      if (result.kind !== 'failed_transient') return;
      expect(result.reason).toMatch(/^dispatcher_crash: /);

      // Critical: the orphan pending row was transitioned. Without
      // this fix the row would orphan forever (retry-pass filters
      // status='failed', dispatcher skips via 'already_sent').
      expect(transitionReminderMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          nextStatus: 'failed',
          failureReason: expect.stringMatching(/^dispatcher_crash: /),
          retryUntil: expect.any(String),
        }),
      );

      // Audit emitted in the SAME defensive tx as the transition
      // (Principle VIII state↔audit atomicity).
      const failedAudit = emitInTxMock.mock.calls.find(
        (c) =>
          c[1].type === 'renewal_reminder_send_failed' &&
          c[1].payload.failure_kind === 'dispatcher_crash',
      );
      expect(failedAudit).toBeDefined();
    });

    it('J2-B2: inner persistence tx throws → defensive cleanup catches + ensures row not orphaned', async () => {
      // Gateway succeeds, but the success-path runInTenant throws
      // mid-flight (e.g., audit_log INSERT serialization failure).
      // Without defensive cleanup the row would orphan at 'pending'.
      const { deps, transitionReminderMock } = fakeDeps({});
      const reminderRepo = deps.reminderEventRepo as unknown as {
        transitionStatus: ReturnType<typeof vi.fn>;
      };
      let callCount = 0;
      reminderRepo.transitionStatus = vi.fn(async (_tx, input) => {
        callCount += 1;
        // First call (success path) throws; second call (defensive
        // cleanup) succeeds.
        if (callCount === 1) {
          throw new Error('audit_log: insert failed');
        }
        return {
          tenantId: TENANT_ID,
          reminderEventId: 'rem-1',
          cycleId: CYCLE_ID,
          stepId: 't-30.email',
          channel: 'email' as const,
          templateId: 'renewal.t-30.regular',
          taskType: null,
          dispatchedAt: null,
          deliveryId: null,
          status: input.nextStatus,
          skipReason: null,
          failureReason: input.failureReason ?? null,
          actorUserId: null,
          yearInCycle: 1,
          createdAt: NOW_ISO,
          retryUntil: input.retryUntil ?? null,
          retryExhaustedAt: null,
        };
      });

      const result = await dispatchOneCycle(deps, buildHappyCandidate(), happyCtx);

      expect(result.kind).toBe('failed_transient');
      // transitionStatus called TWICE: first for success path
      // (threw), second for defensive cleanup (succeeded).
      expect(reminderRepo.transitionStatus).toHaveBeenCalledTimes(2);
      // Voiding the unused mock var avoids lint while documenting
      // the cleanup-tx success.
      void transitionReminderMock;
    });
  });

  describe('admin actor (T089 path)', () => {
    it('records actor_user_id in audit context for admin call', async () => {
      const { deps, emitInTxMock } = fakeDeps({});
      await dispatchOneCycle(deps, buildHappyCandidate(), {
        ...happyCtx,
        actorUserId: 'admin-1',
        actorRole: 'admin',
      });
      const sentAudit = emitInTxMock.mock.calls.find(
        (c) => c[1].type === 'renewal_reminder_sent',
      );
      expect(sentAudit?.[2].actorUserId).toBe('admin-1');
      expect(sentAudit?.[2].actorRole).toBe('admin');
    });
  });

  describe('helpers', () => {
    it('computeYearInCycle: year-1 for now < period_from + 365d', () => {
      expect(
        computeYearInCycle('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'),
      ).toBe(1);
    });

    it('computeYearInCycle: year-2 for now in [period_from + 365d, +730d)', () => {
      expect(
        computeYearInCycle('2026-01-01T00:00:00Z', '2027-01-02T00:00:00Z'),
      ).toBe(2);
    });

    it('computeYearInCycle: clamps to 1 for now < period_from', () => {
      expect(
        computeYearInCycle('2026-06-01T00:00:00Z', '2026-05-01T00:00:00Z'),
      ).toBe(1);
    });

    it('computeCycleYears: 12 months → 1 year', () => {
      expect(computeCycleYears(12)).toBe(1);
    });

    it('computeCycleYears: 36 months → 3 years', () => {
      expect(computeCycleYears(36)).toBe(3);
    });
  });

  it('passes correlationId from ctx to all audit emits', async () => {
    const { deps, emitInTxMock } = fakeDeps({});
    await dispatchOneCycle(deps, buildHappyCandidate(), {
      ...happyCtx,
      correlationId: 'corr-xyz',
    });
    const sentAudit = emitInTxMock.mock.calls.find(
      (c) => c[1].type === 'renewal_reminder_sent',
    );
    expect(sentAudit?.[2].correlationId).toBe('corr-xyz');
  });
});
