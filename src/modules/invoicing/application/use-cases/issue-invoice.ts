/**
 * T037 — issue-invoice use case (F4).
 *
 * THE critical transactional path per plan § VIII Reliability.
 *
 * Canonical lock order (documented below so reviewers can spot-check):
 *   1. invoice row FOR UPDATE (lockForUpdate — serialises concurrent issues)
 *   2. member FOR UPDATE (archive-race guard FR-037)
 *   3. pg_advisory_xact_lock('invoicing:{tenant}:{doc_type}:{fy}')
 *   4. tenant_document_sequences FOR UPDATE (inside allocator)
 *
 * R7-S1 — deadlock-safety rationale:
 *   The (invoice → member → advisory → seq) order is currently
 *   DEADLOCK-FREE against the F3 `archive-member` path. Archive-
 *   member acquires ONLY the member lock (no invoice lock), so:
 *     issue-invoice holds invoice, waits for member
 *     archive-member holds member, does NOT wait for invoice
 *   The waits-for graph has no cycle → no deadlock possible.
 *
 *   IF a future refactor gives archive-member an invoice lock (e.g.
 *   to prevent issuing against a mid-archive member atomically),
 *   this ordering flips to deadlock-prone. At that point REVERSE to
 *   (member → invoice → advisory → seq) — archive-member's single
 *   member-lock acquisition stays compatible, and the waits-for
 *   graph remains acyclic.
 *
 *   Until then, do NOT add an invoice lock to archive-member without
 *   flipping this use-case's lock order FIRST.
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
  enforceOneMembershipLine,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import type { FiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { fiscalYearFromUtcIso } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { calculateVat } from '@/modules/invoicing/domain/policies/calculate-vat';
import { bangkokLocalDate, addDays } from '@/lib/fiscal-year';
import { logger } from '@/lib/logger';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';

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
  | { code: 'invalid_lines'; reason: string }
  | { code: 'overflow'; fiscalYear: FiscalYear }
  | { code: 'pdf_render_failed'; reason: string }
  | { code: 'blob_upload_failed'; reason: string };

/**
 * Internal throw-carrier used to abort the transaction AND propagate a
 * typed error up to the outer `try/catch`. Returning `err(...)` from
 * inside `withTx` resolves the callback normally and the sequence
 * allocator's increment commits — instead we throw so the tx rolls
 * back. See `lib/tx-abort.ts` for the shared pattern.
 */
class IssueInvoiceInternalError extends TxAbort<IssueInvoiceError> {
  // Hardcode the class name so production minifiers (esbuild/Terser)
  // can't mangle it in logger output (L3).
  override readonly name = 'IssueInvoiceInternalError';
}

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

  try {
  return await deps.invoiceRepo.withTx(async (tx) => {
    // --- PRE-SEQUENCE early exits (safe to `return err(...)` — the tx
    // has no state yet, so a committed callback with zero writes is a
    // no-op. DO NOT reorder code below to put these AFTER allocateNext
    // without converting them to throw-carrier; committing a partial
    // tx that already consumed a sequence number creates a §87 gap.

    // A. Settings
    const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
    if (!settings) return err({ code: 'settings_missing' });

    // C1. Row-lock the invoice BEFORE reading the draft — serialises
    // concurrent issue attempts on the same invoice id so two admins
    // clicking "Issue" at once cannot both reach allocateNext.
    const lockedStatus = await deps.invoiceRepo.lockForUpdate(tx, invoiceId, input.tenantId);
    if (!lockedStatus) {
      // R7-W1 — emit cross-tenant probe on not-found (RLS-hidden row
      // looks identical to a genuinely missing id; audit it either
      // way per Constitution Principle I clause 4). Using `null` tx
      // so the audit survives regardless of the outer withTx's
      // commit/rollback outcome — consistent with get-invoice +
      // get-invoice-pdf-signed-url patterns.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Probe on invoice ${invoiceId} (not found on issue)`,
        payload: {
          attempted_invoice_id: invoiceId,
          actor_role: 'admin',
          route: 'issue-invoice',
        },
      });
      return err({ code: 'invoice_not_found' });
    }
    if (lockedStatus !== 'draft') {
      return err({ code: 'invoice_already_issued', status: lockedStatus });
    }

    // C2. Draft invoice (now safely inside the row lock)
    const draft = await deps.invoiceRepo.findByIdInTx(tx, invoiceId, input.tenantId);
    if (!draft) return err({ code: 'invoice_not_found' });

    // B. Member lock (FR-037 archive-race)
    const member = await deps.memberIdentity.getForIssue(
      tx,
      input.tenantId,
      draft.memberId,
      { forUpdate: true },
    );
    if (!member) return err({ code: 'member_not_found' });
    if (member.isArchived) return err({ code: 'member_archived' });

    // Domain invariant — exactly one membership_fee line required
    // before issue (spec § invariant). Runs BEFORE allocateNext so a
    // malformed draft cannot consume a §87 sequence number.
    const linesCheck = enforceOneMembershipLine(draft.lines);
    if (!linesCheck.ok) {
      return err({
        code: 'invalid_lines',
        reason: linesCheck.error.code,
      });
    }

    // D. Fiscal year
    const fy = fiscalYearFromUtcIso(
      now,
      settings.fiscalYearStartMonth as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12,
    );

    // --- POST-SEQUENCE zone begins. Every error path below MUST throw
    // an `IssueInvoiceInternalError` so withTx rolls back and the
    // allocator's increment is NOT committed.

    // E. Allocate sequence
    const seq = await deps.sequenceAllocator.allocateNext(tx, {
      tenantId: input.tenantId,
      documentType: 'invoice',
      fiscalYear: fy,
    });
    const docNum = DocumentNumber.of(settings.invoiceNumberPrefix, fy, seq);
    if (!docNum.ok) {
      // Critical: overflow happens AFTER allocateNext — must throw, not
      // return err, otherwise the tx commits and we leak a §87 gap.
      throw new IssueInvoiceInternalError({ code: 'overflow', fiscalYear: fy });
    }

    // F. Pricing from lines
    let subtotal = Money.zero();
    for (const line of draft.lines) {
      subtotal = subtotal.add(line.total);
    }
    const { vat, total } = calculateVat(subtotal, settings.vatRate);

    // G. Snapshots
    const tenantSnap = settings.identity;
    const memberSnap = member.snapshot;

    // Dates — invoice date follows wall-clock Bangkok, not UTC, so an
    // issuance at 23:30 UTC (= 06:30 Bangkok next day) shows the correct
    // local calendar date on the document.
    const issueDate = bangkokLocalDate(now);
    const dueDate = addDays(issueDate, settings.defaultNetDays);

    // H. Render PDF — typed error on failure. Returning `err(...)` here
    // inside `withTx` still resolves the callback, which WILL commit the
    // sequence allocation — so we throw to force rollback, then catch
    // below and map to a typed Result.
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
      throw new IssueInvoiceInternalError({
        code: 'pdf_render_failed',
        reason: String(e),
      });
    }

    // I. Blob upload — content-addressed key. Wrap in try/catch so blob
    // failures also propagate as typed errors AND roll back the sequence
    // allocation (throw → withTx rollback).
    const blobKey = `invoicing/${input.tenantId}/${fy}/${invoiceId}_v${deps.currentTemplateVersion}.pdf`;
    try {
      await deps.blob.uploadPdf({
        key: blobKey,
        body: rendered.bytes,
        contentType: 'application/pdf',
      });
    } catch (e) {
      throw new IssueInvoiceInternalError({
        code: 'blob_upload_failed',
        reason: String(e),
      });
    }

    // J. UPDATE invoices row. The repo throws if the status guard
    // (WHERE status='draft') doesn't match — treat that as a
    // concurrent re-issue race and surface it as a typed error so the
    // route maps to 409 instead of 500.
    let issued;
    try {
      issued = await deps.invoiceRepo.applyIssue(tx, {
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
        pdf: {
          blobKey,
          sha256: rendered.sha256,
          templateVersion: deps.currentTemplateVersion,
        },
      });
    } catch (e) {
      if (e instanceof InvoiceApplyConflictError && e.kind === 'applyIssue') {
        // Row was 'draft' under the lock but isn't anymore — concurrent
        // re-issue. Surface 'issued' as the inferred new status so
        // callers (and the 409 response) carry useful info.
        throw new IssueInvoiceInternalError({
          code: 'invoice_already_issued',
          status: 'issued',
        });
      }
      throw e;
    }

    // K. Audit
    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'invoice_issued',
      actorUserId: input.actorUserId,
      summary: `Invoice ${docNum.value.raw} issued`,
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
  } catch (e) {
    if (e instanceof IssueInvoiceInternalError) {
      logger.warn(
        {
          err: e.error,
          invoiceId: input.invoiceId,
          tenantId: input.tenantId,
        },
        'issueInvoice: internal error, rolling back',
      );
      return err(e.error);
    }
    throw e;
  }
}
