/**
 * F8 Phase 4 Wave I2d · T090 — `detect-bounce-threshold` use-case.
 *
 * F1 Resend webhook synchronous-call hook per FR-012a + R8 rev-2.
 * Called from the F1 webhook handler (T101, Wave I4) right after a
 * `bounced` event is persisted to `email_delivery_events` for a
 * member's primary contact email. Decides whether the bounce volume
 * has crossed any of three thresholds:
 *
 *   1. **Hard bounce** (`bounce_type = 'permanent'`, e.g. mailbox not
 *      found): trigger on FIRST occurrence — flag and stop.
 *   2. **Soft streak in cycle** (`bounce_type = 'transient'`, ≥3 in
 *      same renewal cycle): transient pattern persistent for one cycle.
 *   3. **Soft rolling 30-day** (≥5 transient bounces in last 30d):
 *      transient pattern across cycles.
 *
 * On threshold cross:
 *   1. `members.email_unverified` flips to TRUE (via Wave I2b's
 *      `memberRenewalFlagsRepo.setEmailUnverified`)
 *   2. Idempotent `manual_outreach_required` escalation task created
 *      (via Wave I2b's `escalationTaskRepo.insertIfAbsent`)
 *   3. Two audits emitted in same tx:
 *      - `member_email_unverified_threshold_crossed` (this wave)
 *      - `escalation_task_created` (Wave I2c enum)
 *
 * Idempotent: if the member's flag is already TRUE (perhaps from a
 * prior threshold crossing), T090 returns `already_unverified` outcome
 * without flipping the flag, creating a duplicate task, or emitting
 * audits. The dispatcher (T088 Gate 6) already respects the flag —
 * subsequent reminders are skipped regardless.
 *
 * NOT exposed via REST. Internal callback fired by F1 webhook.
 *
 * Atomic state+audit per Constitution Principle VIII: flag flip + task
 * insertIfAbsent + 2 audit emits all happen inside ONE `runInTenant` tx.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { randomUUID } from 'node:crypto';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { asTaskId } from '../../domain/renewal-escalation-task';
import { MANUAL_OUTREACH_TASK_TYPE } from './reset-email-unverified';
import type { BounceCounts } from '../ports/bounce-event-query';
import type { MemberId } from '@/modules/members';

/** FR-012a canonical thresholds. Hardcoded per Q4 round 2 (no per-tenant override). */
export const BOUNCE_THRESHOLD_HARD = 1 as const;
export const BOUNCE_THRESHOLD_SOFT_IN_CYCLE = 3 as const;
export const BOUNCE_THRESHOLD_SOFT_30D = 5 as const;

/**
 * Trigger labels per FR-012a audit payload contract. Maps to the three
 * distinct threshold-crossing paths.
 */
export const BOUNCE_TRIGGERS = [
  'hard_bounce',
  'soft_streak',
  'soft_rolling',
] as const;
export type BounceTrigger = (typeof BOUNCE_TRIGGERS)[number];

export const detectBounceThresholdInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  /** Optional clock override for tests. */
  nowIso: z.string().datetime().optional(),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  /** Actor — typically 'webhook'; 'system' for replays. */
  actorRole: z.enum(['webhook', 'system']),
  actorUserId: z.string().nullable().optional(),
});

export type DetectBounceThresholdInput = z.infer<
  typeof detectBounceThresholdInputSchema
>;

export type DetectBounceThresholdOutcome =
  | { readonly kind: 'no_threshold_crossed'; readonly counts: BounceCounts }
  /**
   * J9-M4: split off from the previous catch-all `'already_unverified'`
   * outcome. Now distinguishes:
   *   - `already_unverified` — flag was TRUE before THIS detection
   *     ran (idempotent replay; legitimate no-op).
   *   - `member_not_found` — `setEmailUnverified` returned 0 rows,
   *     meaning the member is RLS-hidden, deleted, or never existed
   *     under this tenant. Webhook caller can elevate this to
   *     `logger.error` + alert (F1↔F8 desync) without conflating
   *     it with normal idempotent replays.
   */
  | { readonly kind: 'already_unverified'; readonly counts: BounceCounts }
  | { readonly kind: 'member_not_found'; readonly counts: BounceCounts }
  | {
      readonly kind: 'threshold_crossed';
      readonly trigger: BounceTrigger;
      readonly bounceCount: number;
      readonly counts: BounceCounts;
      /** False when the escalation task was already open (idempotent replay). */
      readonly escalationTaskCreated: boolean;
      readonly escalationTaskId: string;
    };

export type DetectBounceThresholdError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

/**
 * Threshold decision (first match wins). Returns null when no threshold
 * crossed. Order matters: hard before soft-streak before soft-30d, per
 * FR-012a severity priority.
 */
function classifyTrigger(
  counts: BounceCounts,
): { trigger: BounceTrigger; bounceCount: number } | null {
  if (counts.hardBounces >= BOUNCE_THRESHOLD_HARD) {
    return { trigger: 'hard_bounce', bounceCount: counts.hardBounces };
  }
  if (
    counts.softBouncesInCycle !== null &&
    counts.softBouncesInCycle >= BOUNCE_THRESHOLD_SOFT_IN_CYCLE
  ) {
    return {
      trigger: 'soft_streak',
      bounceCount: counts.softBouncesInCycle,
    };
  }
  if (counts.softBouncesIn30Days >= BOUNCE_THRESHOLD_SOFT_30D) {
    return {
      trigger: 'soft_rolling',
      bounceCount: counts.softBouncesIn30Days,
    };
  }
  return null;
}

export async function detectBounceThreshold(
  deps: RenewalsDeps,
  rawInput: DetectBounceThresholdInput,
): Promise<
  Result<DetectBounceThresholdOutcome, DetectBounceThresholdError>
> {
  const parsed = detectBounceThresholdInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  const nowIso = input.nowIso ?? new Date().toISOString();

  return withActiveSpan(
    renewalsTracer(),
    'bounce_threshold_check',
    {
      'tenant.id': input.tenantId,
      'actor.role': input.actorRole,
    },
    async (span) => {
      const result = await detectInner();
      if (result.ok) {
        span.setAttribute('renewals.outcome_kind', result.value.kind);
        if (result.value.kind === 'threshold_crossed') {
          span.setAttribute('renewals.bounce_trigger', result.value.trigger);
        }
      }
      return result;
    },
  );

  async function detectInner(): Promise<
    Result<DetectBounceThresholdOutcome, DetectBounceThresholdError>
  > {

  // Resolve current active cycle (may be null for pre-renewal members).
  const activeCycle = await deps.cyclesRepo.findActiveForMember(
    input.tenantId,
    input.memberId,
  );
  const cycleStartedAt = activeCycle?.periodFrom ?? null;
  const activeCycleId = activeCycle?.cycleId ?? null;

  // Read bounce counts via the port — production wires
  // `makeDrizzleBounceEventQuery` against F1's `email_delivery_events`
  // (composite filtered-aggregate query that partitions on
  // `bounce_type` + cycle window + 30d rolling window). The
  // `stub-bounce-event-query.ts` file is reserved for unit-test
  // composition only.
  const counts = await deps.bounceEventQuery.countBounces(
    input.tenantId,
    input.memberId,
    { cycleStartedAt, nowIso },
  );

  const decision = classifyTrigger(counts);
  if (decision === null) {
    return ok({ kind: 'no_threshold_crossed', counts });
  }

  // Atomic state+audit. Order:
  //   1. setEmailUnverified — guard against idempotent replay
  //   2. insertIfAbsent task — idempotent on partial UNIQUE
  //   3. emit member_email_unverified_threshold_crossed audit
  //   4. emit escalation_task_created audit (only when task newly created)
  return runInTenant(deps.tenant, async (tx) => {
    const flagResult = await deps.memberRenewalFlagsRepo.setEmailUnverified(
      tx,
      input.tenantId,
      input.memberId,
    );
    if (flagResult.affectedRows === 0) {
      // J9-M4: distinguish "member not found / RLS-hidden" from
      // "member exists with email_unverified already TRUE". The
      // previous code conflated both into `already_unverified`,
      // hiding F1↔F8 desync from operators (a legitimate
      // idempotent replay looks identical in audit + log to a
      // member-deleted-between-webhook-and-callback race).
      logger.warn(
        {
          tenantId: input.tenantId,
          memberId: input.memberId,
          correlationId: input.correlationId,
        },
        'detectBounceThreshold: member row not found (RLS-hidden or deleted) — F1↔F8 desync candidate',
      );
      return ok({ kind: 'member_not_found' as const, counts });
    }
    if (flagResult.previouslyUnverified) {
      // Idempotent replay — flag was already TRUE from a prior threshold
      // crossing. Don't emit duplicate audit, don't create duplicate task.
      return ok({ kind: 'already_unverified' as const, counts });
    }

    // Newly-flagged. Create idempotent escalation task.
    const taskId = asTaskId(randomUUID());
    const taskInsert = await deps.escalationTaskRepo.insertIfAbsent(tx, {
      tenantId: input.tenantId,
      taskId,
      memberId: input.memberId,
      cycleId: activeCycleId,
      taskType: MANUAL_OUTREACH_TASK_TYPE,
      assignedToRole: 'admin',
      dueAt: nowIso,
    });

    // Threshold-crossed audit (always emitted on newly-flagged path).
    await deps.auditEmitter.emitInTx(
      tx,
      {
        type: 'member_email_unverified_threshold_crossed',
        payload: {
          member_id: input.memberId as MemberId,
          trigger: decision.trigger,
          bounce_count: decision.bounceCount,
          hard_bounces: counts.hardBounces,
          soft_in_cycle: counts.softBouncesInCycle,
          soft_30d: counts.softBouncesIn30Days,
          cycle_id: activeCycleId,
          escalation_task_id: taskInsert.row.taskId,
          escalation_task_created: taskInsert.created,
        },
      },
      {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        actorRole: input.actorRole,
        correlationId: input.correlationId,
        requestId: input.requestId ?? null,
        summary:
          `Member ${input.memberId} email_unverified flag set ` +
          `(trigger=${decision.trigger}, count=${decision.bounceCount})`,
      },
    );

    // Task-created audit (only when newly inserted; replay = task was
    // already open, no second audit per idempotent semantics).
    if (taskInsert.created) {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'escalation_task_created',
          payload: {
            task_id: taskInsert.row.taskId,
            task_type: MANUAL_OUTREACH_TASK_TYPE,
            member_id: input.memberId as MemberId,
            cycle_id: activeCycleId,
            trigger_reason: 'bounce_threshold_crossed',
            bounce_trigger: decision.trigger,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId ?? null,
          actorRole: input.actorRole,
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
          summary: `manual_outreach_required task created (bounce threshold ${decision.trigger})`,
        },
      );
    }

    return ok({
      kind: 'threshold_crossed' as const,
      trigger: decision.trigger,
      bounceCount: decision.bounceCount,
      counts,
      escalationTaskCreated: taskInsert.created,
      escalationTaskId: taskInsert.row.taskId,
    });
  });
  }
}
