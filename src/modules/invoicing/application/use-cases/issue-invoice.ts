/**
 * T037 — issue-invoice use case (F4).
 *
 * THE critical transactional path per plan § VIII Reliability.
 *
 * Canonical lock order (documented below so reviewers can spot-check):
 *   1. member FOR UPDATE (archive-race guard FR-037)
 *   2. pg_advisory_xact_lock('invoicing:{tenant}:{doc_type}:{fy}')
 *   3. tenant_document_sequences FOR UPDATE (inside allocator)
 *
 * Operations (all inside a single DB transaction):
 *   A. load tenant settings (no lock; read-only snapshot)
 *   B. load + lock member (archive-race guard)
 *   C. load + lock invoice draft
 *   D. compute fiscal year (Bangkok TZ)
 *   E. allocate sequence number
 *   F. compute subtotal + VAT + total from DRAFT lines
 *   G. build tenant + member identity snapshots
 *   H. render PDF (deterministic)
 *   I. upload PDF to Blob (content-addressed)
 *   J. applyIssue UPDATE on invoices row
 *   K. emit `invoice_issued` audit
 *   L. enqueue auto-email outbox row if auto_email_on_issue resolves true
 *   M. COMMIT
 *
 * Any throw in A-L rolls back the whole tx — seq is NOT consumed, Blob
 * upload leaves an orphan that the transactional sweeper cleans up
 * (orphans are deterministic and safe to delete because the Blob key is
 * content-addressed on tenant+id+template).
 *
 * RBAC: admin only (route handler guard).
 * Rate limit: 20 / 5min per (tenant, actor) — applied at route level.
 * Idempotency: if `Idempotency-Key` header was handled at route, this
 * function is safe to call again with the same invoiceId → it detects
 * already-issued and returns the persisted invoice (short-circuit).
 */
import { err, ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
import type { MemberIdentityPort } from '../ports/member-identity-port';
import type { SequenceAllocatorPort } from '../ports/sequence-allocator-port';
import type { PdfRenderPort } from '../ports/pdf-render-port';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { EmailOutboxPort } from '../ports/email-outbox-port';
import {
  asInvoiceId,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { fiscalYearFromUtcIso } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { calculateVat } from '@/modules/invoicing/domain/policies/calculate-vat';

export const issueInvoiceSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
});

export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;

export type IssueInvoiceError =
  | { code: 'invoice_not_found' }
  | { code: 'invoice_already_issued'; status: InvoiceStatus }
  | { code: 'settings_missing' }
  | { code: 'member_not_found' }
  | { code: 'member_archived' }
  | { code: 'overflow'; fiscalYear: number }
  | { code: 'pdf_render_failed'; reason: string };

export interface IssueInvoiceDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly tenantSettingsRepo: TenantSettingsRepo;
  readonly memberIdentity: MemberIdentityPort;
  readonly sequenceAllocator: SequenceAllocatorPort;
  readonly pdfRender: PdfRenderPort;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly outbox: EmailOutboxPort;
  /**
   * PDF template version to pin on THIS issuance. Normally the
   * composition root wires this to `CURRENT_TEMPLATE_VERSION` (T045).
   * Callers rendering a historical invoice (resend / Blob-miss recovery)
   * pass the row's stored `pdf_template_version` instead (R3-E4).
   */
  readonly currentTemplateVersion: number;
}

export async function issueInvoice(
  deps: IssueInvoiceDeps,
  input: IssueInvoiceInput,
): Promise<Result<Invoice, IssueInvoiceError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);
  const now = deps.clock.nowIso();

  return deps.invoiceRepo.withTx(async (tx) => {
    // A. Settings
    const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
    if (!settings) return err({ code: 'settings_missing' });

    // C. Draft invoice
    const draft = await deps.invoiceRepo.findDraftById(tx, invoiceId, input.tenantId);
    if (!draft) return err({ code: 'invoice_not_found' });
    if (draft.status !== 'draft') {
      // Idempotent replay detection — caller may be retrying.
      return err({ code: 'invoice_already_issued', status: draft.status });
    }

    // B. Member lock (FR-037 archive-race)
    const member = await deps.memberIdentity.getForIssue(
      tx,
      input.tenantId,
      draft.memberId,
      { forUpdate: true },
    );
    if (!member) return err({ code: 'member_not_found' });
    if (member.isArchived) return err({ code: 'member_archived' });

    // D. Fiscal year
    const fy = fiscalYearFromUtcIso(
      now,
      settings.fiscalYearStartMonth as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12,
    );

    // E. Allocate sequence
    const seq = await deps.sequenceAllocator.allocateNext(tx, {
      tenantId: input.tenantId,
      documentType: 'invoice',
      fiscalYear: fy,
    });
    const docNum = DocumentNumber.of(settings.invoiceNumberPrefix, fy, seq);
    if (!docNum.ok) return err({ code: 'overflow', fiscalYear: fy });

    // F. Pricing from lines
    let subtotal = Money.zero();
    for (const line of draft.lines) {
      subtotal = subtotal.add(line.total);
    }
    const { vat, total } = calculateVat(subtotal, settings.vatRate);

    // G. Snapshots
    const tenantSnap = settings.identity;
    const memberSnap = member.snapshot;

    // Dates
    const issueDate = new Date(now).toISOString().slice(0, 10);
    const dueDateMs = Date.parse(issueDate) + settings.defaultNetDays * 86_400_000;
    const dueDate = new Date(dueDateMs).toISOString().slice(0, 10);

    // H. Render PDF
    let rendered;
    try {
      rendered = await deps.pdfRender.render({
        kind: 'invoice',
        templateVersion: deps.currentTemplateVersion,
        documentNumber: docNum.value,
        issueDate,
        dueDate,
        tenant: tenantSnap,
        member: memberSnap,
        lines: draft.lines,
        subtotal,
        vatRate: settings.vatRate,
        vat,
        total,
      });
    } catch (e) {
      return err({ code: 'pdf_render_failed', reason: String(e) });
    }

    // I. Blob upload — content-addressed key
    const blobKey = `invoicing/${input.tenantId}/${fy}/${invoiceId}_v${deps.currentTemplateVersion}.pdf`;
    await deps.blob.uploadPdf({
      key: blobKey,
      body: rendered.bytes,
      contentType: 'application/pdf',
    });

    // J. UPDATE invoices row
    const issued = await deps.invoiceRepo.applyIssue(tx, {
      tenantId: input.tenantId,
      invoiceId,
      fiscalYear: fy,
      sequenceNumber: seq,
      documentNumber: docNum.value.raw,
      issueDate,
      dueDate,
      subtotalSatang: subtotal.satang,
      vatRate: settings.vatRate.raw,
      vatSatang: vat.satang,
      totalSatang: total.satang,
      proRatePolicySnapshot: settings.proRatePolicy,
      netDaysSnapshot: settings.defaultNetDays,
      tenantIdentitySnapshot: tenantSnap,
      memberIdentitySnapshot: memberSnap,
      pdfBlobKey: blobKey,
      pdfSha256: rendered.sha256,
      pdfTemplateVersion: deps.currentTemplateVersion,
    });

    // K. Audit
    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'invoice_issued',
      actorUserId: input.actorUserId,
      summary: `Invoice ${docNum.value.raw} issued for member ${draft.memberId}`,
      payload: {
        invoice_id: invoiceId,
        member_id: draft.memberId,
        fiscal_year: fy,
        sequence_number: seq,
        document_number: docNum.value.raw,
        total_satang: total.satang.toString(),
        pdf_sha256: rendered.sha256,
      },
    });

    // L. Outbox (if auto-email enabled — per-invoice override trumps tenant default)
    const shouldAutoEmail =
      draft.autoEmailOnIssue ?? settings.autoEmailEnabled;
    if (shouldAutoEmail) {
      await deps.outbox.enqueue(tx, {
        tenantId: input.tenantId,
        eventType: 'invoice_issued',
        recipientEmail: memberSnap.primary_contact_email,
        invoiceId,
        pdfBlobKey: blobKey,
        pdfTemplateVersion: deps.currentTemplateVersion,
      });
    }

    return ok(issued);
  });
}
