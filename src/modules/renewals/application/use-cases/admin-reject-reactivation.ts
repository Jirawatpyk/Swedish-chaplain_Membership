/**
 * F8 Phase 5 Wave A.5 · T137 — `adminRejectReactivation`.
 *
 * Admin rejects a cycle stuck in `pending_admin_reactivation` after a
 * payment landed against an admin-blocked auto-reactivation member
 * (FR-005d). The use-case:
 *
 *   1. Validates cycle is in `pending_admin_reactivation`.
 *   2. Acquires per-cycle advisory lock + tx-bound re-read (TOCTOU).
 *   3. Calls F5 `issueRefundForInvoice` for the cycle's linked invoice.
 *      F5 cascades F4 credit-note creation in-tx (verified at Pre-Wave
 *      A, see `src/modules/payments/application/use-cases/issue-refund.ts`).
 *   4. Transitions cycle pending → cancelled with `closed_reason =
 *      'admin_rejected_with_refund'`.
 *   5. Emits `lapsed_member_admin_reactivation_rejected` audit (typed
 *      payload includes refund credit-note ID for forensics).
 *
 * Concurrency / atomicity:
 *   - F5 refund call is OUTSIDE the F8 tx (Stripe API is non-transactional);
 *     this matches F5's own two-tx design (Phase A → Stripe → Phase B).
 *     If F8's cycle-transition + audit-emit fails AFTER F5 refunded, the
 *     cycle stays in `pending_admin_reactivation` — admin retries via
 *     T138 (reconcile-pending) or manual support runbook. F5's audit
 *     row + credit-note row are durable so the refund won't double-issue.
 *   - The cycle transition + audit-emit do run in a single F8 tx
 *     (Constitution Principle VIII).
 *
 * Edge case — `no_payment_found`: a cycle can enter
 * `pending_admin_reactivation` via a non-payment path (e.g., a future
 * manual admin pre-block before any payment). Reject still proceeds:
 * cycle moves to cancelled, but the audit's `refund_credit_note_id`
 * is null (not "we issued a $0 refund").
 *
 * RBAC: admin role only. Manager-role rejected by route handler.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { asUserId } from '@/modules/auth/domain/branded';
import { asCreditNoteId, asInvoiceId } from '@/modules/invoicing';
import { asTenantId } from '@/modules/members';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { F5RefundBridge } from '../ports/f5-refund-bridge';
import {
  parseCycleId,
  type CycleId,
  type RenewalCycle,
} from '../../domain/renewal-cycle';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '../ports/renewal-cycle-repo';
import { asTaskId } from '../../domain/renewal-escalation-task';

export const adminRejectReactivationInputSchema = z.object({
  tenantId: z.string().min(1),
  cycleId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
  // Staff-Review-2026-05-09 R2-W3 fix: optional injected clock for
  // determinism + unit testability without `vi.setSystemTime`. Caller
  // (POST /api/admin/renewals/[cycleId]/reject) defaults to wall-clock
  // `new Date()` — same observable behaviour as before for the route
  // handler, but enables consistent fixturisation in unit + integration
  // tests and aligns with the WRN-12 fix in `lapseCyclesOnGraceExpiry`.
  now: z.date().optional(),
});

export type AdminRejectReactivationInput = z.infer<
  typeof adminRejectReactivationInputSchema
>;

export interface AdminRejectReactivationOutput {
  readonly cycleStatus: 'cancelled';
  readonly closedReason: 'admin_rejected_with_refund';
  readonly closedAt: string;
  /** Null when no payment was found (cycle entered pending without one). */
  readonly refundCreditNoteId: string | null;
}

export type AdminRejectReactivationError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'cycle_not_found' }
  | {
      readonly kind: 'cycle_not_pending';
      readonly currentStatus: string;
    }
  | {
      readonly kind: 'cycle_missing_invoice';
    }
  | {
      readonly kind: 'refund_failed';
      readonly errorCode: string;
      readonly detail: string;
    }
  | { readonly kind: 'server_error'; readonly message: string };

/**
 * Subset of `RenewalsDeps` actually needed. T137 also requires the F5
 * refund bridge which is not yet wired into `RenewalsDeps`'s default
 * factory (production wiring lands with T142 admin route + T139/T140
 * cron routes); test composition supplies a mock directly via this
 * narrower deps shape. When the production bridge ships, swap to the
 * full `RenewalsDeps` import + lift the `f5RefundBridge` field there.
 *
 * I9 review-fix: `escalationTaskRepo` added so the use-case inserts a
 * `post_refund_review` row in the same tx as the cycle transition +
 * audit emit. Finance team consumes the queue from
 * `/admin/renewals/escalations` to verify the F5 refund and reconcile
 * the F4 credit-note in their bank-rec workflow.
 */
export interface AdminRejectReactivationDeps
  extends Pick<
    RenewalsDeps,
    'tenant' | 'cyclesRepo' | 'auditEmitter' | 'escalationTaskRepo'
  > {
  readonly f5RefundBridge: F5RefundBridge;
}

/**
 * I9 review-fix: task_type literal for finance follow-up rows created
 * after a successful admin-reject + F5 refund. Idempotent on
 * `(tenant, member, cycle, task_type) WHERE status='open'` per the
 * partial-unique-index contract on `renewal_escalation_tasks_open_idem_idx`.
 */
const POST_REFUND_REVIEW_TASK_TYPE = 'post_refund_review' as const;
const POST_REFUND_REVIEW_DUE_DAYS = 3;

export async function adminRejectReactivation(
  deps: AdminRejectReactivationDeps,
  rawInput: AdminRejectReactivationInput,
): Promise<
  Result<AdminRejectReactivationOutput, AdminRejectReactivationError>
> {
  const parsed = adminRejectReactivationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  const cycleIdParsed = parseCycleId(input.cycleId);
  if (!cycleIdParsed.ok) {
    return err({ kind: 'invalid_input', message: 'invalid cycle id' });
  }
  const cycleId: CycleId = cycleIdParsed.value;

  // Step 1-2: validate state + acquire lock + tx-bound re-read in own tx.
  // The refund call (step 3) runs OUTSIDE the tx (Stripe is external),
  // so we close this read tx before invoking F5.
  let lockedCycle: RenewalCycle;
  {
    const stateResult = await runInTenant(deps.tenant, async (tx) => {
      await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);
      const cycle = await deps.cyclesRepo.findByIdInTx(
        tx,
        input.tenantId,
        cycleId,
      );
      if (!cycle) {
        return err({ kind: 'cycle_not_found' as const });
      }
      if (cycle.status !== 'pending_admin_reactivation') {
        return err({
          kind: 'cycle_not_pending' as const,
          currentStatus: cycle.status,
        });
      }
      return ok(cycle);
    });
    if (!stateResult.ok) return err(stateResult.error);
    lockedCycle = stateResult.value;
  }

  // Step 3: refund via F5 bridge (outside F8 tx — Stripe is external).
  let refundCreditNoteId: string | null = null;
  if (lockedCycle.linkedInvoiceId === null) {
    // Cycle has no linked invoice — cannot refund. Treat as
    // no-payment-found path (audit refund_credit_note_id stays null).
    refundCreditNoteId = null;
  } else {
    // Round 2 (S-9): wrap raw strings in branded IDs at the bridge
    // boundary. The bridge input type now demands TenantId/InvoiceId
    // brands so a swapped (tenantId, invoiceId) call no longer
    // type-checks. F8-internal use-case input stays `string` for now
    // — adoption is incremental per S-9 scope policy.
    const refundResult = await deps.f5RefundBridge.issueRefundForInvoice({
      tenantId: asTenantId(input.tenantId),
      invoiceId: asInvoiceId(lockedCycle.linkedInvoiceId),
      reason: input.reason,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      requestId: input.requestId ?? null,
    });
    if (refundResult.status === 'refund_failed') {
      logger.warn(
        {
          cycleId: lockedCycle.cycleId,
          invoiceId: lockedCycle.linkedInvoiceId,
          errorCode: refundResult.errorCode,
        },
        '[admin-reject-reactivation] F5 refund failed — cycle stays pending for retry',
      );
      // I9 review-fix: alertable failure metric so SRE pages on a
      // sustained F5-refund-pipeline outage instead of waiting for an
      // admin to escalate manually.
      renewalsMetrics.adminRejectCompleted(input.tenantId, 'failed');
      return err({
        kind: 'refund_failed',
        errorCode: refundResult.errorCode,
        detail: refundResult.detail,
      });
    }
    if (refundResult.status === 'refunded') {
      refundCreditNoteId = refundResult.creditNoteId;
    }
    // status === 'no_payment_found' → refundCreditNoteId stays null
  }

  // Step 4-5: transition cycle + emit audit atomically.
  // R2-W3: prefer injected `now` over wall-clock for clock determinism.
  const now = input.now ?? new Date();
  const closedAt = now.toISOString();
  return runInTenant(deps.tenant, async (tx) => {
    // Staff-Review-2026-05-09 WRN-1 fix: re-acquire the per-cycle
    // advisory lock at the top of tx2. tx1 (validate) released the
    // lock at COMMIT, then the F5 refund call ran without any lock
    // held. Without this re-acquire two admins double-clicking
    // "reject" can both pass `transitionStatus(from='pending...')`
    // because Postgres locks rows only at FOR UPDATE / FOR NO KEY
    // UPDATE — the cycle row itself is not held between the F5
    // refund call and the transition. The advisory lock here serialises
    // tx2 on the (tenant, cycle) namespace so a second admin's tx2
    // blocks until ours commits, after which their `transitionStatus`
    // raises CycleTransitionConflictError (idempotent — refund cascade
    // is no-op via F5 credit-note uniqueness). Mirrors the lock pattern
    // in lapseCyclesOnGraceExpiry + reconcilePendingReactivations.
    await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);
    let updated: RenewalCycle;
    try {
      updated = await deps.cyclesRepo.transitionStatus(
        tx,
        input.tenantId,
        cycleId,
        {
          from: 'pending_admin_reactivation',
          to: 'cancelled',
          closedAt,
          closedReason: 'admin_rejected_with_refund',
        },
      );
    } catch (e) {
      if (e instanceof CycleTransitionConflictError) {
        // Another tx moved the cycle out of pending between our refund
        // call and this transition. Refund already issued (irreversible)
        // — surface a server_error so the admin can investigate via
        // F5 refund history + cycle audit trail.
        logger.error(
          {
            cycleId,
            refundCreditNoteId,
            err: e.message,
          },
          '[admin-reject-reactivation] refund issued but cycle transition lost race — manual reconciliation needed',
        );
        renewalsMetrics.adminRejectCompleted(input.tenantId, 'failed');
        return err({
          kind: 'server_error',
          message:
            'refund issued but cycle transition lost race — see runbook',
        });
      }
      if (e instanceof CycleNotFoundError) {
        renewalsMetrics.adminRejectCompleted(input.tenantId, 'failed');
        return err({ kind: 'cycle_not_found' });
      }
      logger.error(
        { err: e instanceof Error ? e.message : String(e), cycleId },
        '[admin-reject-reactivation] cycle transition failed',
      );
      renewalsMetrics.adminRejectCompleted(input.tenantId, 'failed');
      return err({
        kind: 'server_error',
        message: 'cycle transition failed',
      });
    }

    try {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'lapsed_member_admin_reactivation_rejected' as const,
          payload: {
            cycle_id: updated.cycleId,
            actor_user_id: asUserId(input.actorUserId),
            refund_credit_note_id:
              refundCreditNoteId === null
                ? null
                : asCreditNoteId(refundCreditNoteId),
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: 'admin',
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      // Constitution Principle VIII reverse-direction: throw to roll
      // back the transition. The refund stays issued — same situation
      // as the TransitionConflict branch (manual reconciliation).
      // Round-3 silent-failure F7 fix: log refundCreditNoteId loud +
      // mark `refundIssuedRequiresReconciliation` so SRE can filter
      // for refund-orphan rollbacks in pino → Sentry queries.
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          cycleId,
          tenantId: input.tenantId,
          refundCreditNoteId,
          refundIssuedRequiresReconciliation: refundCreditNoteId !== null,
        },
        '[admin-reject-reactivation] audit emit failed inside tx — rolling back; refund stays issued, manual reconciliation required when refundCreditNoteId is set',
      );
      throw e;
    }

    // I9 review-fix: insert a `post_refund_review` escalation task so
    // finance closes the loop on the F5 refund + F4 credit-note in
    // their bank-rec queue. Idempotent: a re-fired admin-reject (e.g.
    // double-click) finds the open row + reuses it instead of stacking
    // duplicates. Only insert when a refund actually issued —
    // `no_payment_found` cycles need no finance follow-up.
    if (refundCreditNoteId !== null) {
      // R2-W3: derive dueAt from the same `now` used for closedAt so
      // the audit trail is consistent (review queue shows the same
      // reference clock as the cycle-close timestamp).
      const dueAt = new Date(
        now.getTime() + POST_REFUND_REVIEW_DUE_DAYS * 86_400_000,
      ).toISOString();
      try {
        const taskInsert = await deps.escalationTaskRepo.insertIfAbsent(tx, {
          tenantId: input.tenantId,
          taskId: asTaskId(randomUUID()),
          memberId: lockedCycle.memberId,
          cycleId,
          taskType: POST_REFUND_REVIEW_TASK_TYPE,
          assignedToRole: 'admin',
          dueAt,
        });
        if (taskInsert.created) {
          await deps.auditEmitter.emitInTx(
            tx,
            {
              type: 'escalation_task_created' as const,
              payload: {
                task_id: taskInsert.row.taskId,
                task_type: POST_REFUND_REVIEW_TASK_TYPE,
                member_id: lockedCycle.memberId,
                cycle_id: cycleId,
                trigger_reason: 'admin_reject_with_refund',
                refund_credit_note_id: refundCreditNoteId,
              },
            },
            {
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              actorRole: 'admin',
              correlationId: input.correlationId,
              requestId: input.requestId ?? null,
              summary: `post_refund_review task created for credit-note ${refundCreditNoteId}`,
            },
          );
        }
      } catch (e) {
        // Same Principle VIII reverse-direction as the prior emit —
        // throwing rolls back the cycle transition + the lapsed-member
        // audit, preserving state↔audit↔task atomicity.
        // Round-3 silent-failure F7 fix: log refundCreditNoteId loud
        // (we're inside `if (refundCreditNoteId !== null)` so it's
        // guaranteed set here) so SRE sees the orphaned refund in the
        // alert payload.
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            cycleId,
            tenantId: input.tenantId,
            refundCreditNoteId,
            refundIssuedRequiresReconciliation: true,
          },
          '[admin-reject-reactivation] escalation task insert failed — rolling back; refund stays issued, manual reconciliation required',
        );
        throw e;
      }
    }

    renewalsMetrics.adminRejectCompleted(
      input.tenantId,
      refundCreditNoteId === null ? 'no_payment' : 'refunded',
    );

    return ok({
      cycleStatus: 'cancelled' as const,
      closedReason: 'admin_rejected_with_refund' as const,
      closedAt,
      refundCreditNoteId,
    });
  });
}
