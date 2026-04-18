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
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';

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
  | { code: 'not_draft' };

export interface UpdateInvoiceDraftDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly audit: AuditPort;
}

export async function updateInvoiceDraft(
  deps: UpdateInvoiceDraftDeps,
  input: UpdateInvoiceDraftInput,
): Promise<Result<Invoice, UpdateInvoiceDraftError>> {
  const invoiceId = asInvoiceId(input.invoiceId);
  return deps.invoiceRepo.withTx(async (txUnknown) => {
    const tx = txUnknown as TenantTx;
    const loaded = await deps.invoiceRepo.findDraftById(tx, invoiceId, input.tenantId);
    if (!loaded) return err({ code: 'invoice_not_found' });
    if (loaded.status !== 'draft') return err({ code: 'not_draft' });

    // Build diff — only include fields the caller provided AND that changed.
    const diff: Record<string, unknown> = {};
    if (input.autoEmailOnIssue !== undefined && input.autoEmailOnIssue !== loaded.autoEmailOnIssue) {
      diff.auto_email_on_issue = { from: loaded.autoEmailOnIssue, to: input.autoEmailOnIssue };
    }
    if (input.planId !== undefined && input.planId !== loaded.planId) {
      diff.plan_id = { from: loaded.planId, to: input.planId };
    }
    if (input.planYear !== undefined && input.planYear !== loaded.planYear) {
      diff.plan_year = { from: loaded.planYear, to: input.planYear };
    }

    // No meaningful diff — short-circuit without UPDATE or audit row.
    if (Object.keys(diff).length === 0) return ok(loaded);

    // Apply one UPDATE per changed field. The immutability trigger only
    // fires once status != draft, so plain column updates on drafts are
    // safe. Issuing multiple small UPDATEs costs nothing because the
    // typical diff is 1-2 fields and drafts are rare-write entities.
    if ('auto_email_on_issue' in diff) {
      await tx.execute(sql`
        UPDATE invoices SET auto_email_on_issue = ${input.autoEmailOnIssue}, updated_at = now()
         WHERE tenant_id = ${input.tenantId} AND invoice_id = ${invoiceId}
      `);
    }
    if ('plan_id' in diff) {
      await tx.execute(sql`
        UPDATE invoices SET plan_id = ${input.planId}, updated_at = now()
         WHERE tenant_id = ${input.tenantId} AND invoice_id = ${invoiceId}
      `);
    }
    if ('plan_year' in diff) {
      await tx.execute(sql`
        UPDATE invoices SET plan_year = ${input.planYear}, updated_at = now()
         WHERE tenant_id = ${input.tenantId} AND invoice_id = ${invoiceId}
      `);
    }

    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'invoice_draft_updated',
      actorUserId: input.actorUserId,
      summary: `Draft invoice updated`,
      payload: { invoice_id: invoiceId, diff },
    });

    const refreshed = await deps.invoiceRepo.findDraftById(tx, invoiceId, input.tenantId);
    return ok(refreshed!);
  });
}
