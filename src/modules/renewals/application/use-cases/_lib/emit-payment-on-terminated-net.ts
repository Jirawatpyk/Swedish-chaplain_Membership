/**
 * 066 §4.4(2) — the shared "payment on a terminated member" NET.
 *
 * A payment that settles against a member whose membership is already
 * TERMINATED can slip past the §4.4(1) gate in two residual ways, each with
 * its own heal site:
 *   - `terminal_only`         — an UNLINKED membership invoice paid for a
 *     member with cycles but none open (resolveUnlinkedMembershipPaymentInTx).
 *   - `linked_terminal_skip`  — a payment on the LAPSED cycle's OWN linked
 *     invoice, the webhook race (markCycleCompleteFromInvoicePaid).
 *
 * Both must emit the SAME instrumentation — a `payment_on_terminated_member`
 * audit event (10-year retention) + an idempotent `post_termination_payment_
 * review` admin work-item + the `paymentOnTerminatedMember` metric — atomically
 * in F4's payment tx (Constitution Principle VIII). This helper is the single
 * source of that shape so the two heal sites can never DRIFT (the +7-day due
 * window, the task_type, the audit payload keys, the audit actor). The audit
 * context is IDENTICAL at both sites (a `system` actor + `f4-paid:{invoiceId}`
 * correlation), so it is computed here rather than passed in.
 *
 * Throws on infra failure (emitInTx / insertIfAbsent) — never swallowed — so
 * the payment tx rolls back and the webhook retry heals (the on-paid contract).
 */
import { randomUUID } from 'node:crypto';
import { renewalsMetrics } from '@/lib/metrics';
import type { TenantTx } from '@/lib/db';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { asMemberId } from '@/modules/members';
import { asTaskId } from '../../../domain/renewal-escalation-task';
import type { RenewalAuditEmitter } from '../../ports/renewal-audit-emitter';
import type { RenewalEscalationTaskRepo } from '../../ports/renewal-escalation-task-repo';

export type PaymentOnTerminatedHealSite = 'terminal_only' | 'linked_terminal_skip';

export interface EmitPaymentOnTerminatedNetDeps {
  readonly auditEmitter: Pick<RenewalAuditEmitter, 'emitInTx'>;
  readonly escalationTaskRepo: Pick<RenewalEscalationTaskRepo, 'insertIfAbsent'>;
}

export async function emitPaymentOnTerminatedNet(
  deps: EmitPaymentOnTerminatedNetDeps,
  tx: TenantTx,
  args: {
    /** The F4 paid event — source of invoice/amount/method/trigger/paidAt/tenant. */
    readonly event: F4InvoicePaidEvent;
    /**
     * The member the receipt was minted to. `terminal_only` sources it from the
     * event; `linked_terminal_skip` from the cycle — passed explicitly so the
     * exact per-site source is preserved.
     */
    readonly memberId: string;
    /** null for the unlinked terminal_only site; the cycle id for linked. */
    readonly cycleId: string | null;
    readonly healSite: PaymentOnTerminatedHealSite;
  },
): Promise<void> {
  const { event, memberId, cycleId, healSite } = args;
  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'payment_on_terminated_member' as const,
      payload: {
        invoice_id: event.invoiceId,
        member_id: asMemberId(memberId),
        cycle_id: cycleId,
        amount_satang: event.amountSatang.toString(),
        payment_method: event.paymentMethod,
        triggered_by: event.triggeredBy,
        paid_at: event.paidAt,
        heal_site: healSite,
      },
    },
    {
      tenantId: event.tenantId,
      actorUserId: null,
      actorRole: 'system' as const,
      correlationId: `f4-paid:${event.invoiceId}`,
    },
  );
  // Admin work-item. Idempotency: the (tenant, member, cycle, task_type)
  // WHERE status='open' partial unique index dedupes daily re-runs — EXCEPT the
  // terminal_only site where cycle_id is NULL (Postgres NULLS DISTINCT); there
  // the primary guard is recordPayment's paid-invoice REPLAY guard (an
  // already-paid invoice never re-fires the on-paid chain).
  await deps.escalationTaskRepo.insertIfAbsent(tx, {
    tenantId: event.tenantId,
    taskId: asTaskId(randomUUID()),
    memberId,
    cycleId,
    taskType: 'post_termination_payment_review',
    assignedToRole: 'admin',
    dueAt: new Date(Date.parse(event.paidAt) + 7 * 86_400_000).toISOString(),
  });
  renewalsMetrics.paymentOnTerminatedMember(healSite);
}
