/**
 * 107-auto-invoice Task 14 — `discardAutoDraftedRenewal`.
 *
 * The admin review-queue's manual "Discard" action. Deletes an
 * `origin='auto_renewal' status='draft'` invoice a treasurer has decided
 * NOT to issue this cycle (billing the member a different way, or the
 * draft's numbers look wrong and a fresh cron pass should re-draft it).
 *
 * Thin Application-layer wrapper around the SAME F4 bridge primitive
 * `issueAutoDraftedRenewal`'s own tx1 sibling-sweep uses
 * (`f4InvoicingBridge.discardAutoDraftForRenewal`) — see that port's
 * docstring: "Task 14's manual Discard queue action consumes this too — the
 * only difference between the two callers is the renewals-side
 * `renewal_auto_draft_discarded.reason` they emit alongside it." Composes
 * F4's own `deleteInvoiceDraft` use-case (never a direct DELETE on F4's
 * `invoices` table — Constitution Principle III), so F4's own audit
 * (`invoice_draft_deleted`) and status guard both still apply.
 *
 * Discard + the F8 audit emit share ONE `runInTenant` transaction
 * (Constitution Principle VIII state↔audit atomicity), mirroring
 * `pruneAutoDrafts` and `issueAutoDraftedRenewal`'s own tx3
 * (`discardSupersededDrafts`) — never a fire-and-forget `emit()` outside a
 * tx for a real state mutation. No per-cycle advisory lock is needed: the
 * bridge's DELETE re-asserts `status='draft'` atomically inside the SQL
 * statement, so a concurrent Issue action can never be clobbered by this
 * route — whichever writer's DELETE actually removes the row wins; the
 * loser sees `not_draft` and correctly leaves the row alone (see
 * `delete-invoice-draft.ts`'s TOCTOU-safe DELETE, Task 9 §5).
 *
 * `expectMayHaveVanished` is deliberately OMITTED — the invoiceId here
 * comes straight from the request path (the caller's own admin UI, not a
 * tenant-scoped read this use-case performed itself), so a genuine
 * not-found MUST still trip F4's `invoice_cross_tenant_probe` forensic
 * audit (see `DeleteInvoiceDraftInput.expectMayHaveVanished`'s docstring:
 * "never set it for an id sourced from a request body").
 *
 * An orphaned draft (Task 7's documented "orphaned after commit" window —
 * `renewal_cycles.auto_draft_invoice_id` never got stamped) is still
 * discardable: there's no F8 cycle to attach the timeline event to, so the
 * F8-specific audit is skipped (F4's own `invoice_draft_deleted` still
 * records the deletion) — surfaced to the caller via `auditEmitted: false`
 * rather than silently pretending the F8 event fired.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { asMemberId } from '@/modules/members';
import { parseInput, type InvalidInputError } from './_lib/parse-input';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

export const discardAutoDraftedRenewalInputSchema = z.object({
  tenantId: z.string().min(1),
  invoiceId: z.string().uuid(),
  actorUserId: z.string().min(1),
  // 016 post-ship B-1 — the LITERAL staff role the gate admits, threaded
  // into every audit emit below (a hardcoded 'admin' misattributed every
  // post-Migration-C discard).
  actorRole: z.enum(['admin', 'super_admin']),
  requestId: z.string().nullable().optional(),
});

export type DiscardAutoDraftedRenewalInput = z.infer<
  typeof discardAutoDraftedRenewalInputSchema
>;

export interface DiscardAutoDraftedRenewalOutput {
  readonly invoiceId: string;
  /**
   * False only for an orphaned draft (no cycle stamped with this invoice
   * id) — see module header. The draft IS discarded either way.
   */
  readonly auditEmitted: boolean;
}

/**
 * `not_draft` — a concurrent Issue action promoted the row first (the
 * status-guarded DELETE matched 0 rows). `not_found` — the id doesn't
 * exist / belongs to another tenant (RLS-hidden); F4's own
 * `deleteInvoiceDraft` emits `invoice_cross_tenant_probe` for this case.
 */
export type DiscardAutoDraftedRenewalError =
  | InvalidInputError
  | { readonly kind: 'not_draft' }
  | { readonly kind: 'not_found' };

export type DiscardAutoDraftedRenewalDeps = Pick<
  RenewalsDeps,
  'tenant' | 'cyclesRepo' | 'auditEmitter' | 'f4InvoicingBridge'
>;

export async function discardAutoDraftedRenewal(
  deps: DiscardAutoDraftedRenewalDeps,
  rawInput: DiscardAutoDraftedRenewalInput,
): Promise<
  Result<DiscardAutoDraftedRenewalOutput, DiscardAutoDraftedRenewalError>
> {
  const inputResult = parseInput(discardAutoDraftedRenewalInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;
  const requestId = input.requestId ?? null;

  return runInTenant(deps.tenant, async (tx) => {
    const result = await deps.f4InvoicingBridge.discardAutoDraftForRenewal({
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      requestId,
      tx,
    });
    if (result.status === 'not_draft') {
      return err({ kind: 'not_draft' as const });
    }
    if (result.status === 'not_found') {
      return err({ kind: 'not_found' as const });
    }

    // --- discarded — resolve the F8 cycle for the audit payload ---------
    const cycle = await deps.cyclesRepo.findByAutoDraftInvoiceIdInTx(
      tx,
      input.tenantId,
      input.invoiceId,
    );
    if (cycle) {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_auto_draft_discarded' as const,
          payload: {
            cycle_id: cycle.cycleId,
            member_id: asMemberId(cycle.memberId),
            invoice_id: input.invoiceId,
            reason: 'manual' as const,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          correlationId: input.invoiceId,
          requestId,
        },
      );
    } else {
      logger.warn(
        { tenantId: input.tenantId, invoiceId: input.invoiceId },
        '[discard-auto-drafted-renewal] discarded an orphaned draft (no stamped cycle) — F8 audit trail skipped (F4 invoice_draft_deleted still recorded)',
      );
    }

    return ok({ invoiceId: input.invoiceId, auditEmitted: cycle !== null });
  });
}
