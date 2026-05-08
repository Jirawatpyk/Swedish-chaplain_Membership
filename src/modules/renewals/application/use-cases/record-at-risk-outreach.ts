/**
 * F8 Phase 6 Wave B · T156 — `recordAtRiskOutreach` use-case.
 *
 * Admin OR manager "Contact" CTA from the at-risk widget per FR-033 +
 * FR-052a manager exception (manager records outreach for board-level
 * relationship tracking — the only F8 mutating endpoint manager can
 * invoke). Inserts a row into `at_risk_outreach` (data-model.md § 2.5;
 * migration 0090) capturing the channel + optional template + outcome
 * note. The 7-day reminder pause cascade triggers automatically — the
 * existing `pause-reminders-after-outreach.ts` use-case (Phase 4 Wave
 * I2a, T092) reads `at_risk_outreach` rows in the last 7 days during
 * dispatch, so simply inserting a row is enough.
 *
 * Authz: admin OR manager (FR-052a manager exception). The route
 * handler enforces session-based admin/manager gate; this use-case
 * accepts both via the actorRole zod literal-union and persists the
 * caller's role on the audit row so dashboards can attribute outreach
 * to admin vs manager.
 *
 * Audit: emits `at_risk_outreach_recorded` (typed payload added Phase
 * 6 Wave A2). Atomic with the INSERT per Constitution Principle VIII.
 *
 * Migration 0090 enforces the channel-template discriminant:
 *   - email ⇒ template_id NOT NULL
 *   - phone OR meeting ⇒ template_id NULL
 * The zod schema mirrors this with a `superRefine` so the use-case
 * surfaces friendly `invalid_input` errors before the DB CHECK fires.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import {
  OUTREACH_CHANNELS,
  type OutreachId,
} from '../../domain/at-risk-outreach';
// Type-only import — runtime no-op brand cast (Constitution Principle III)
import type { MemberId } from '@/modules/members';

export const recordAtRiskOutreachInputSchema = z
  .object({
    tenantId: z.string().min(1),
    memberId: z.string().uuid(),
    channel: z.enum(OUTREACH_CHANNELS),
    templateId: z.string().min(1).max(100).optional(),
    outcomeNote: z.string().trim().max(500).optional(),
    actorUserId: z.string().min(1),
    actorRole: z.union([z.literal('admin'), z.literal('manager')]),
    requestId: z.string().nullable().optional(),
    correlationId: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    // Mirror migration 0090 channel-template discriminant CHECK so the
    // use-case surfaces a friendly error before the DB raises a CHECK
    // violation. Defence-in-depth — if a misbehaving caller bypasses
    // this, the DB still catches it and rolls back the tx.
    if (value.channel === 'email' && !value.templateId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['templateId'],
        message: 'templateId required when channel is email',
      });
    }
    if (value.channel !== 'email' && value.templateId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['templateId'],
        message: 'templateId not allowed unless channel is email',
      });
    }
  });

export type RecordAtRiskOutreachInput = z.infer<
  typeof recordAtRiskOutreachInputSchema
>;

export interface RecordAtRiskOutreachOutput {
  /** UUID generated server-side via DB DEFAULT `gen_random_uuid()`. */
  readonly outreachId: string;
  /** ISO 8601 UTC timestamp set by DB DEFAULT NOW(). */
  readonly createdAt: string;
}

export type RecordAtRiskOutreachError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string };

export async function recordAtRiskOutreach(
  deps: RenewalsDeps,
  rawInput: RecordAtRiskOutreachInput,
): Promise<Result<RecordAtRiskOutreachOutput, RecordAtRiskOutreachError>> {
  const inputResult = parseInput(recordAtRiskOutreachInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  return runInTenant(deps.tenant, async (tx) => {
    let inserted: { outreachId: string; createdAt: string };
    try {
      const writeInput: Parameters<
        typeof deps.atRiskOutreachWriteRepo.insertOutreachInTx
      >[2] = {
        memberId: input.memberId,
        channel: input.channel,
        actorUserId: input.actorUserId,
        ...(input.templateId !== undefined
          ? { templateId: input.templateId }
          : {}),
        ...(input.outcomeNote !== undefined && input.outcomeNote.length > 0
          ? { outcomeNote: input.outcomeNote }
          : {}),
      };
      const result = await deps.atRiskOutreachWriteRepo.insertOutreachInTx(
        tx,
        input.tenantId,
        writeInput,
      );
      inserted = {
        outreachId: result.outreachId,
        createdAt: result.createdAt,
      };
    } catch (e) {
      // CHECK constraint violation OR FK violation on a non-existent
      // member surfaces here. Map to typed error so the caller can
      // 4xx instead of 5xx for known invariants.
      const message = e instanceof Error ? e.message : String(e);
      logger.error(
        { err: message, tenantId: input.tenantId, memberId: input.memberId },
        '[record-at-risk-outreach] insert failed',
      );
      return err({ kind: 'server_error' as const, message });
    }

    try {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'at_risk_outreach_recorded' as const,
          payload: {
            member_id: input.memberId as MemberId,
            outreach_id: inserted.outreachId as OutreachId,
            channel: input.channel,
            template_id: input.templateId ?? null,
            actor_role: input.actorRole,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      // Reverse-direction atomicity per Constitution Principle VIII —
      // audit failure rolls the INSERT back.
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        '[record-at-risk-outreach] audit emit failed inside tx — rolling back',
      );
      throw e;
    }
    return ok(inserted);
  });
}
