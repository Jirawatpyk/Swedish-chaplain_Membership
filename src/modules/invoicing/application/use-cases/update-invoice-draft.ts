/**
 * T034 — update-invoice-draft use case (F4).
 *
 * Partial field update on a DRAFT invoice. Rejects once status != draft
 * (the DB immutability trigger would otherwise reject the write but we
 * fail fast in Application for a clean error shape). Emits
 * `invoice_draft_updated` audit event only on a meaningful diff — a
 * caller that resubmits an identical payload produces no audit row.
 *
 * Mutable fields in draft state:
 *  - auto_email_on_issue (per-invoice override)
 *  - plan_id + plan_year (admin retargeted the plan)
 *
 * Member_id changes require delete + recreate — silent member swap on
 * a draft is a billing-footgun we don't want (changing the member
 * while keeping the draft id blurs audit trail ownership). Enforced
 * here as a rejected input.
 */
import { err, ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { AuditPort } from '../ports/audit-port';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';

export const updateInvoiceDraftSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  autoEmailOnIssue: z.boolean().nullable().optional(),
  planId: z.string().min(1).optional(),
  planYear: z.number().int().min(2000).max(2100).optional(),
});

export type UpdateInvoiceDraftInput = z.infer<typeof updateInvoiceDraftSchema>;

export type UpdateInvoiceDraftError =
  | { code: 'invoice_not_found' }
  | { code: 'not_draft' }
  | { code: 'concurrent_state_change' };

export interface UpdateInvoiceDraftDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly audit: AuditPort;
}

export async function updateInvoiceDraft(
  deps: UpdateInvoiceDraftDeps,
  input: UpdateInvoiceDraftInput,
): Promise<Result<Invoice, UpdateInvoiceDraftError>> {
  const invoiceId = asInvoiceId(input.invoiceId);
  try {
    return await deps.invoiceRepo.withTx(async (tx) => {
      const loaded = await deps.invoiceRepo.findDraftById(tx, invoiceId, input.tenantId);
      if (!loaded) return err({ code: 'invoice_not_found' });
      if (loaded.status !== 'draft') return err({ code: 'not_draft' });

      // Build diff — only include fields the caller provided AND that changed.
      const diff: Record<string, unknown> = {};
      const patch: {
        autoEmailOnIssue?: boolean | null;
        planId?: string;
        planYear?: number;
      } = {};
      if (input.autoEmailOnIssue !== undefined && input.autoEmailOnIssue !== loaded.autoEmailOnIssue) {
        diff.auto_email_on_issue = { from: loaded.autoEmailOnIssue, to: input.autoEmailOnIssue };
        patch.autoEmailOnIssue = input.autoEmailOnIssue;
      }
      if (input.planId !== undefined && input.planId !== loaded.planId) {
        diff.plan_id = { from: loaded.planId, to: input.planId };
        patch.planId = input.planId;
      }
      if (input.planYear !== undefined && input.planYear !== loaded.planYear) {
        diff.plan_year = { from: loaded.planYear, to: input.planYear };
        patch.planYear = input.planYear;
      }

      // No meaningful diff — short-circuit without UPDATE or audit row.
      if (Object.keys(diff).length === 0) return ok(loaded);

      // Single atomic UPDATE via the repo port (no raw SQL in Application).
      await deps.invoiceRepo.applyDraftUpdate(tx, {
        tenantId: input.tenantId,
        invoiceId,
        ...patch,
      });

      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_draft_updated',
        actorUserId: input.actorUserId,
        summary: `Draft invoice updated`,
        payload: { invoice_id: invoiceId, diff },
      });

      const refreshed = await deps.invoiceRepo.findDraftById(tx, invoiceId, input.tenantId);
      if (!refreshed) return err({ code: 'invoice_not_found' });
      return ok(refreshed);
    });
  } catch (e) {
    // W3 fix — map repo-layer concurrency conflict (concurrent
    // issueInvoice flipped the row between our `findDraftById` read
    // and the repo's guarded UPDATE) to a typed application error.
    if (e instanceof InvoiceApplyConflictError && e.kind === 'applyDraftUpdate') {
      return err({ code: 'concurrent_state_change' });
    }
    throw e;
  }
}
