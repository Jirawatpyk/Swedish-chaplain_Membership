/**
 * T107 — resend-pdf use case (F4 / Phase 10).
 *
 * Admin + member-portal "email me a copy" flow. Enqueues a fresh
 * outbox row carrying the **pinned** `pdf_template_version` from the
 * stored document (per R3-E4) so the dispatcher re-renders bit-for-bit
 * identical bytes from the stored Blob key — no render drift.
 *
 * Three variants via discriminated input:
 *   - `{ kind: 'invoice', variant: 'invoice' }`      → resend invoice PDF
 *   - `{ kind: 'invoice', variant: 'receipt' }`      → resend receipt PDF (paid only)
 *   - `{ kind: 'credit_note' }`                      → resend credit-note PDF
 *
 * Ownership guards mirror `get-invoice` / `get-credit-note`:
 *   - admin/manager: cross-tenant probe emit on not-found → 404
 *   - member: same-tenant-different-member → opaque 404 + probe audit
 *
 * Rate-limit (per spec T107): 1 resend per document per 5 min.
 *   The window is PER DOCUMENT, not per actor — even an admin acting on
 *   behalf of a member cannot mail-bomb the same invoice. Enforced at
 *   the route layer (shared Upstash bucket) so the use-case stays pure.
 *
 * Audit:
 *   - `invoice_pdf_resent`      — carries `member_id` (F3 timeline)
 *   - `receipt_pdf_resent`      — no `member_id` (operational duplicate
 *                                 of `invoice_paid`, excluded from F3
 *                                 timeline by design — see
 *                                 `F4_MEMBER_TIMELINE_EVENT_TYPES` in
 *                                 `src/modules/invoicing/index.ts`)
 *   - `credit_note_pdf_resent`  — no `member_id` (duplicate of
 *                                 `credit_note_issued`)
 *
 * Outbox + audit are emitted OUTSIDE a tx (they are append-only,
 * read-only-against-mutations, and do not advance §87 state). If the
 * outbox enqueue fails after the audit lands, the audit row is a
 * harmless trace of an attempted resend. If the audit emit fails after
 * the outbox lands, the cron dispatcher still sends the PDF and
 * `pino` captures the audit-write failure — member receives the email
 * either way.
 */
import { err, ok, type Result } from '@/lib/result';
import { sha256Hex } from '@/lib/crypto';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { CreditNoteRepo } from '../ports/credit-note-repo';
import type { AuditPort } from '../ports/audit-port';
import type { EmailOutboxPort, F4OutboxLocale } from '../ports/email-outbox-port';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { asCreditNoteId } from '@/modules/invoicing/domain/credit-note';

/**
 * R19 / QA TC-03 H-1 — long-retention PII minimisation.
 *
 * Audit rows retain for 10 years (FR-029 tax-document retention). Raw
 * `recipient_email` in the audit payload is Category B PII per
 * `security.md § 4`; the append-only append log cannot be edited to
 * remove it later. Store a normalised sha256 instead so:
 *   (a) Ops can still correlate resend events against a submitted
 *       email without carrying plaintext for a decade.
 *   (b) Identical resends produce identical hashes → duplicate
 *       detection on the audit trail still works.
 *
 * The user-facing `ResendPdfOutput.recipientEmail` keeps the plaintext
 * because it's the operator's immediate confirmation ("resent to
 * ops@example.com") — short-lived, not stored.
 */
function hashRecipientEmail(raw: string): string {
  return sha256Hex(raw.trim().toLowerCase());
}

export type ResendPdfActor =
  | {
      readonly userId: string;
      readonly role: 'admin' | 'manager';
      readonly requestId: string | null;
    }
  | {
      readonly userId: string;
      readonly role: 'member';
      readonly memberId: string;
      readonly requestId: string | null;
    };

export type ResendPdfInput =
  | {
      readonly tenantId: string;
      readonly kind: 'invoice';
      readonly invoiceId: string;
      /**
       * Which PDF to resend:
       *   - 'invoice': the tax invoice (available as soon as status=issued)
       *   - 'receipt': the receipt PDF (only available once status=paid
       *     AND the tenant uses separate-mode; combined-mode has no
       *     distinct receipt so this variant is rejected)
       */
      readonly variant: 'invoice' | 'receipt';
      readonly actor: ResendPdfActor;
      /**
       * Optional override — defaults to the stored member primary
       * contact email from the invoice's identity snapshot. Admins may
       * future-supply a delegated address; MVP keeps it snapshot-bound.
       */
      readonly recipientEmailOverride?: string;
      readonly recipientLocale?: F4OutboxLocale;
    }
  | {
      readonly tenantId: string;
      readonly kind: 'credit_note';
      readonly creditNoteId: string;
      readonly actor: ResendPdfActor;
      readonly recipientEmailOverride?: string;
      readonly recipientLocale?: F4OutboxLocale;
    };

export type ResendPdfError =
  | { readonly code: 'not_found' }
  | { readonly code: 'forbidden' }
  /**
   * invoice is still draft — no issued PDF to resend. The admin UI
   * should hide the button in this state, but guard defence-in-depth.
   */
  | { readonly code: 'not_issued' }
  /**
   * Receipt variant requested but the invoice has no distinct receipt
   * PDF (either not paid, or combined-mode where the invoice PDF is
   * the combined receipt). The admin UI should hide `Resend receipt`
   * for these states.
   */
  | { readonly code: 'no_receipt_pdf' };

export interface ResendPdfDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly creditNoteRepo: CreditNoteRepo;
  readonly audit: AuditPort;
  readonly outbox: EmailOutboxPort;
}

export interface ResendPdfOutput {
  readonly documentNumber: string;
  readonly recipientEmail: string;
}

export async function resendPdf(
  deps: ResendPdfDeps,
  input: ResendPdfInput,
): Promise<Result<ResendPdfOutput, ResendPdfError>> {
  if (input.kind === 'invoice') {
    return resendInvoiceOrReceipt(deps, input);
  }
  return resendCreditNote(deps, input);
}

async function resendInvoiceOrReceipt(
  deps: ResendPdfDeps,
  input: Extract<ResendPdfInput, { kind: 'invoice' }>,
): Promise<Result<ResendPdfOutput, ResendPdfError>> {
  const invoice = await deps.invoiceRepo.findById(
    asInvoiceId(input.invoiceId),
    input.tenantId,
  );

  if (!invoice) {
    await deps.audit.emit(null, {
      tenantId: input.tenantId,
      requestId: input.actor.requestId,
      eventType: 'invoice_cross_tenant_probe',
      actorUserId: input.actor.userId,
      summary: `Probe on invoice ${input.invoiceId} (resend — not found in actor tenant)`,
      payload: {
        attempted_invoice_id: input.invoiceId,
        actor_role: input.actor.role,
        route: 'resend-pdf',
        variant: input.variant,
      },
    });
    return err({ code: 'not_found' });
  }

  // Member ownership guard — opaque 404 mirrors get-invoice.
  if (input.actor.role === 'member') {
    if (invoice.memberId !== input.actor.memberId) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.actor.requestId,
        eventType: 'invoice_cross_tenant_probe',
        actorUserId: input.actor.userId,
        summary: `Member probe on non-owned invoice ${input.invoiceId} (resend)`,
        payload: {
          attempted_invoice_id: input.invoiceId,
          actor_role: 'member',
          actor_member_id: input.actor.memberId,
          invoice_member_id: invoice.memberId,
          route: 'resend-pdf',
          variant: input.variant,
        },
      });
      return err({ code: 'not_found' });
    }
  }

  // Pick the right pinned PDF metadata for the variant.
  const pdf = input.variant === 'invoice' ? invoice.pdf : invoice.receiptPdf;
  if (!pdf) {
    return err({
      code: input.variant === 'invoice' ? 'not_issued' : 'no_receipt_pdf',
    });
  }

  const recipientEmail =
    input.recipientEmailOverride ??
    invoice.memberIdentitySnapshot?.primary_contact_email;
  if (!recipientEmail) {
    // No snapshot ⇒ not issued. Defence-in-depth for racy state.
    return err({ code: 'not_issued' });
  }

  const documentNumber = invoice.documentNumber?.raw ?? '';
  const outboxEventType =
    input.variant === 'invoice' ? 'invoice_pdf_resent' : 'receipt_pdf_resent';

  // Outbox enqueue — uses PINNED templateVersion from the invoice's
  // stored PDF so the dispatcher re-signs the same Blob key rather
  // than re-rendering a drifted template (R3-E4).
  await deps.outbox.enqueue(null, {
    tenantId: input.tenantId,
    eventType: outboxEventType,
    recipientEmail,
    ...(input.recipientLocale ? { recipientLocale: input.recipientLocale } : {}),
    invoiceId: input.invoiceId,
    pdfBlobKey: pdf.blobKey,
    pdfTemplateVersion: pdf.templateVersion,
    ...(documentNumber ? { documentNumber } : {}),
  });

  // Audit — invoice_pdf_resent ships with member_id (F3 timeline
  // surface per US7 / FR-033). receipt_pdf_resent does NOT carry
  // member_id by design (operational duplicate; would double-render
  // on the timeline alongside invoice_paid).
  const recipientHash = hashRecipientEmail(recipientEmail);
  if (outboxEventType === 'invoice_pdf_resent') {
    await deps.audit.emit(null, {
      tenantId: input.tenantId,
      requestId: input.actor.requestId,
      eventType: 'invoice_pdf_resent',
      actorUserId: input.actor.userId,
      // P2 Wave-0 (PDPA data-minimization): the `summary` column persists for
      // the audit row's FULL retention (5–10y), exactly like the payload — it is
      // NOT transient. So it must not carry plaintext PII. The hashed recipient
      // lives in `payload.recipient_email_sha256` for correlation.
      summary: `Invoice ${documentNumber} PDF resent (recipient hashed in payload)`,
      payload: {
        invoice_id: input.invoiceId,
        member_id: invoice.memberId,
        document_number: documentNumber,
        recipient_email_sha256: recipientHash,
        actor_role: input.actor.role,
        pdf_template_version: pdf.templateVersion,
      },
    });
  } else {
    await deps.audit.emit(null, {
      tenantId: input.tenantId,
      requestId: input.actor.requestId,
      eventType: 'receipt_pdf_resent',
      actorUserId: input.actor.userId,
      summary: `Receipt for invoice ${documentNumber} resent (recipient hashed in payload)`,
      payload: {
        invoice_id: input.invoiceId,
        document_number: documentNumber,
        recipient_email_sha256: recipientHash,
        actor_role: input.actor.role,
        pdf_template_version: pdf.templateVersion,
      },
    });
  }

  return ok({ documentNumber, recipientEmail });
}

async function resendCreditNote(
  deps: ResendPdfDeps,
  input: Extract<ResendPdfInput, { kind: 'credit_note' }>,
): Promise<Result<ResendPdfOutput, ResendPdfError>> {
  const cn = await deps.creditNoteRepo.findById(
    asCreditNoteId(input.creditNoteId),
    input.tenantId,
  );

  if (!cn) {
    await deps.audit.emit(null, {
      tenantId: input.tenantId,
      requestId: input.actor.requestId,
      eventType: 'credit_note_cross_tenant_probe',
      actorUserId: input.actor.userId,
      summary: `Probe on credit note ${input.creditNoteId} (resend — not found in actor tenant)`,
      payload: {
        attempted_credit_note_id: input.creditNoteId,
        actor_role: input.actor.role,
        route: 'resend-pdf',
      },
    });
    return err({ code: 'not_found' });
  }

  if (input.actor.role === 'member') {
    if (cn.originalInvoiceMemberId !== input.actor.memberId) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.actor.requestId,
        eventType: 'credit_note_cross_tenant_probe',
        actorUserId: input.actor.userId,
        summary: `Member ownership mismatch on credit note ${input.creditNoteId} (resend)`,
        payload: {
          attempted_credit_note_id: input.creditNoteId,
          actor_role: 'member',
          attempted_member_id: input.actor.memberId,
          route: 'resend-pdf',
        },
      });
      return err({ code: 'not_found' });
    }
  }

  const recipientEmail =
    input.recipientEmailOverride ?? cn.memberIdentitySnapshot.primary_contact_email;

  await deps.outbox.enqueue(null, {
    tenantId: input.tenantId,
    eventType: 'credit_note_pdf_resent',
    recipientEmail,
    ...(input.recipientLocale ? { recipientLocale: input.recipientLocale } : {}),
    creditNoteId: input.creditNoteId,
    pdfBlobKey: cn.pdf.blobKey,
    pdfTemplateVersion: cn.pdf.templateVersion,
    documentNumber: cn.documentNumber.raw,
  });

  await deps.audit.emit(null, {
    tenantId: input.tenantId,
    requestId: input.actor.requestId,
    eventType: 'credit_note_pdf_resent',
    actorUserId: input.actor.userId,
    summary: `Credit note ${cn.documentNumber.raw} PDF resent to ${recipientEmail}`,
    payload: {
      credit_note_id: input.creditNoteId,
      original_invoice_id: cn.originalInvoiceId,
      document_number: cn.documentNumber.raw,
      recipient_email_sha256: hashRecipientEmail(recipientEmail),
      actor_role: input.actor.role,
      pdf_template_version: cn.pdf.templateVersion,
    },
  });

  return ok({ documentNumber: cn.documentNumber.raw, recipientEmail });
}
