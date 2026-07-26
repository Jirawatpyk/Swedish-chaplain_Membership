/**
 * `bulk-send-renewal-reminder` use-case (#4 members-ux).
 *
 * Admin-triggered bulk "Send renewal reminder" from the members directory.
 * Best-effort PER MEMBER — a queued reminder email cannot be un-queued, so this
 * is NOT an all-or-nothing transaction (mirrors F1's `bulkSendPortalInvite`).
 * For each member it resolves the unique active renewal cycle and fires the
 * SAME F8 dispatch the per-cycle "Send reminder now" button uses
 * (`sendReminderNow` → `dispatchOneCycle`), so the reminder ladder, idempotency,
 * and audit are all reused — no new email type, no new audit event.
 *
 * Members with no active cycle, or whose cycle has no step due / is opted out /
 * lacks a primary contact, are reported as SKIPPED (never emailed). The caller
 * surfaces the sent / skipped / failed breakdown in a toast.
 *
 * Cross-module note: the members bulk route (presentation) orchestrates this
 * renewals use-case — a clean presentation-level composition, same pattern as
 * the invite branch calling into F1.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { sendReminderNow } from './send-reminder-now';

export const bulkSendRenewalReminderInputSchema = z.object({
  tenantId: z.string().min(1),
  memberIds: z.array(z.string().uuid()).min(1).max(100),
  actorUserId: z.string().min(1),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type BulkSendRenewalReminderInput = z.infer<
  typeof bulkSendRenewalReminderInputSchema
>;

export interface BulkSendRenewalReminderOutput {
  readonly sent: readonly string[];
  readonly skipped: readonly { readonly memberId: string; readonly reason: string }[];
  readonly failed: readonly { readonly memberId: string; readonly code: string }[];
  readonly counts: {
    readonly sent: number;
    readonly skipped: number;
    readonly failed: number;
  };
}

export type BulkSendRenewalReminderError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

export async function bulkSendRenewalReminder(
  deps: RenewalsDeps,
  rawInput: BulkSendRenewalReminderInput,
): Promise<Result<BulkSendRenewalReminderOutput, BulkSendRenewalReminderError>> {
  const parsed = bulkSendRenewalReminderInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;

  const sent: string[] = [];
  const skipped: { memberId: string; reason: string }[] = [];
  const failed: { memberId: string; code: string }[] = [];

  // ONE instant for the whole batch so every dispatch judges "due today"
  // against the same moment.
  const nowIso = new Date().toISOString();

  // Sequential: each dispatch consumes the per-cycle idempotency + shared bulk
  // rate primitives, so concurrency would only add contention without changing
  // the ≤100-member wall-clock materially.
  for (const memberId of input.memberIds) {
    // Per-member isolation (mirrors bulkSendPortalInvite): `findActiveForMember`
    // is a bare `runInTenant` SQL call and `sendReminderNow` reads its candidate
    // BEFORE its own try/catch, so a transient Neon fault (deadlock / pooler
    // statement_timeout drop / reset) REJECTS here. Without this catch one
    // mid-batch throw would abort the whole loop AFTER real reminder emails were
    // already dispatched — and the caller would 500 with no breakdown, unable to
    // tell which members were already emailed. Bucket the thrower as failed and
    // keep going so the batch stays best-effort.
    try {
      const cycle = await deps.cyclesRepo.findActiveForMember(
        input.tenantId,
        memberId,
      );
      if (!cycle) {
        skipped.push({ memberId, reason: 'no_active_cycle' });
        continue;
      }

      const res = await sendReminderNow(deps, {
        tenantId: input.tenantId,
        cycleId: cycle.cycleId,
        actorUserId: input.actorUserId,
        actorRole: 'admin',
        correlationId: input.correlationId,
        requestId: input.requestId ?? null,
        nowIso,
      });

      if (!res.ok) {
        // `cycle_not_found` here is a race (the cycle went terminal between the
        // findActive read and the dispatch) — report it as no-active-cycle, not
        // a hard failure. Everything else is a genuine failure bucket.
        if (res.error.kind === 'cycle_not_found') {
          skipped.push({ memberId, reason: 'no_active_cycle' });
        } else {
          failed.push({ memberId, code: res.error.kind });
        }
        continue;
      }

      const outcome = res.value;
      switch (outcome.kind) {
        case 'sent':
          sent.push(memberId);
          break;
        case 'skipped':
          skipped.push({ memberId, reason: outcome.reason });
          break;
        case 'task_created':
          // The ladder created an escalation task instead of emailing — no
          // reminder was sent, so report it as skipped (honest for the toast).
          skipped.push({ memberId, reason: 'task_created' });
          break;
        case 'failed_transient':
        case 'failed_permanent':
          failed.push({ memberId, code: outcome.kind });
          break;
        default: {
          // Exhaustiveness guard: a future 6th outcome kind must not silently
          // drop a member (counts would then sum < memberIds.length).
          const _never: never = outcome;
          failed.push({ memberId, code: 'unhandled_outcome' });
          void _never;
          break;
        }
      }
    } catch (e) {
      logger.error(
        {
          err: errKind(e),
          tenantId: input.tenantId,
          memberId,
          correlationId: input.correlationId,
        },
        'bulk-reminder: member threw — bucketed as failed, batch continues',
      );
      failed.push({ memberId, code: 'server_error' });
      continue;
    }
  }

  return ok({
    sent,
    skipped,
    failed,
    counts: {
      sent: sent.length,
      skipped: skipped.length,
      failed: failed.length,
    },
  });
}
