/**
 * F8 Phase 4 Wave I2c · T089 — `send-reminder-now` use-case.
 *
 * Admin-triggered single-cycle dispatch per FR-018: shares the SAME
 * `dispatchOneCycle` core function as the cron entry (T088 single
 * source of truth). The only difference is `actorUserId` — admin's
 * UUID instead of cron's `null` system actor.
 *
 * Surfaces:
 *   - `POST /api/admin/renewals/[cycleId]/send-reminder-now` (T107,
 *     Wave I6) — admin-only RBAC enforced at the route handler.
 *   - Admin "Send reminder" button in the pipeline dashboard (T108,
 *     Wave I6/I7) — toast feedback per FR-058.
 *
 * Concurrent-admin handling per Edge Case at spec.md:197 — when two
 * admins simultaneously click "Send reminder now" on the same cycle,
 * the FR-011 idempotency primitive ensures the second action returns
 * `idempotency_hit` (not a 200 sent). The route handler maps to HTTP
 * 409 with toast info.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { parseCycleId } from '../../domain/renewal-cycle';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  dispatchOneCycle,
  type DispatchOneCycleOutcome,
} from './_lib/dispatch-one-cycle';

export const sendReminderNowInputSchema = z.object({
  tenantId: z.string().min(1),
  cycleId: z.string().uuid(),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  nowIso: z.string().datetime().optional(),
});

export type SendReminderNowInput = z.infer<typeof sendReminderNowInputSchema>;

export type SendReminderNowOutput = DispatchOneCycleOutcome;

export type SendReminderNowError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'cycle_not_found' };

export async function sendReminderNow(
  deps: RenewalsDeps,
  rawInput: SendReminderNowInput,
): Promise<Result<SendReminderNowOutput, SendReminderNowError>> {
  return withActiveSpan(
    renewalsTracer(),
    'admin_send_reminder_now',
    {
      'tenant.id': rawInput.tenantId,
      'cycle.id': rawInput.cycleId,
      'actor.role': rawInput.actorRole,
    },
    async (span) => {
      const result = await sendInner();
      if (result.ok) {
        span.setAttribute('renewals.outcome_kind', result.value.kind);
      }
      return result;
    },
  );

  async function sendInner(): Promise<
    Result<SendReminderNowOutput, SendReminderNowError>
  > {
  const parsed = sendReminderNowInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  const cycleIdResult = parseCycleId(input.cycleId);
  if (!cycleIdResult.ok) {
    return err({ kind: 'invalid_input', message: 'invalid cycle id' });
  }
  const candidate = await deps.dispatchCandidateRepo.findOne(
    input.tenantId,
    cycleIdResult.value,
  );
  if (!candidate) {
    // No probe audit emitted — admin manual action; missing cycle
    // is a UI state mismatch (admin clicked stale row) not a probe.
    return err({ kind: 'cycle_not_found' });
  }
  const nowIso = input.nowIso ?? new Date().toISOString();
  try {
    const outcome = await dispatchOneCycle(deps, candidate, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorRole: 'admin',
      correlationId: input.correlationId,
      requestId: input.requestId ?? null,
      nowIso,
    });
    return ok(outcome);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        cycleId: input.cycleId,
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        correlationId: input.correlationId,
      },
      'sendReminderNow: dispatch unexpected error',
    );
    throw e;
  }
  }
}
