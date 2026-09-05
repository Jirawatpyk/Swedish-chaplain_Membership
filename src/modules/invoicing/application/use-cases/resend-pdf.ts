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
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { CreditNoteRepo } from '../ports/credit-note-repo';
import { emitNonMemberInvoiceEvent, type AuditPort } from '../ports/audit-port';
import type { EmailOutboxPort, F4OutboxLocale } from '../ports/email-outbox-port';
import type { RecipientLocalePort } from '../ports/recipient-locale-port';
import {
  auditAutoEmailSkippedNoRecipient,
  resolveMoneyRecipient,
} from '../lib/resolve-money-recipient';
import { asInvoiceId, billFirstDocumentNumber } from '@/modules/invoicing/domain/invoice';
import { asCreditNoteId } from '@/modules/invoicing/domain/credit-note';
import type { Role } from '@/modules/auth';

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
      /** 016 T030/T033 — the literal STAFF role (member stays its own arm so
       *  the discriminated union keeps narrowing on `role === 'member'`). */
      readonly role: Exclude<Role, 'member'>;
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
       *   - 'receipt': the receipt PDF — available once status=paid in BOTH
       *     numbering modes (record-payment renders invoice.receiptPdf for
       *     combined AND separate); rejected with `no_receipt_pdf` only when
       *     no receipt PDF exists yet (i.e. not paid).
       */
      readonly variant: 'invoice' | 'receipt';
      readonly actor: ResendPdfActor;
      /**
       * 108 — `recipientEmailOverride` was deleted here. It never had a
       * caller, and a hand-supplied address on a money email is exactly the
       * bypass FR-001 exists to close: the recipient is always the live
       * primary contact, resolved at enqueue.
       */
      readonly recipientLocale?: F4OutboxLocale;
    }
  | {
      readonly tenantId: string;
      readonly kind: 'credit_note';
      readonly creditNoteId: string;
      readonly actor: ResendPdfActor;
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
  | { readonly code: 'no_receipt_pdf' }
  /**
   * 108 FR-003 — the member has no contact with `is_primary AND removed_at
   * IS NULL`, so there is no address to resend to and no fallback is
   * permitted. Routes map this to 409 so the admin is told to fix the
   * contact rather than being shown a success toast for a mail nobody got.
   */
  | { readonly code: 'no_recipient' }
  /**
   * Round-4 finding #6 — a NON-MEMBER event invoice whose typed buyer address
   * is empty. Kept distinct from `no_recipient` because that code's copy sends
   * staff to a member page, and this row has no member.
   */
  | { readonly code: 'no_buyer_email' };

export interface ResendPdfDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly creditNoteRepo: CreditNoteRepo;
  readonly audit: AuditPort;
  readonly outbox: EmailOutboxPort;
  /**
   * Email-locale audit 2026-07-16 — resolves the member preference when the
   * caller didn't supply `recipientLocale` (no production route ever did —
   * the input field was dead code since R7-S2).
   */
  readonly recipientLocale: RecipientLocalePort;
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

  if (!invoice.memberIdentitySnapshot) {
    // No snapshot ⇒ not issued. Defence-in-depth for racy state.
    return err({ code: 'not_issued' });
  }
  // Defence-in-depth: memberId null AND eventRegistrationId null is a
  // structurally-impossible row (violates `invoices_subject_fields_ck` — a row
  // is EITHER a member invoice OR a non-member event invoice). This guard runs
  // BEFORE any side effect (outbox enqueue / audit emit): on such a row we
  // cannot construct a valid audit payload (neither `member_id` nor
  // `event_registration_id` correlates), so we must NOT have already sent the
  // email by the time we return the error — otherwise the caller sees a
  // failure while the buyer still receives the PDF. No PII in the log (ids
  // only, per CLAUDE.md § Secrets).
  //
  // It also runs before the recipient resolve, and that ordering is not
  // incidental (review round 3 finding #12). 108 first put the resolve above
  // it, and for a memberless row the resolver reads the SNAPSHOT: an empty
  // address there returned `no_recipient` first, so staff were told to "add a
  // contact" for an invoice that has no member at all, and this warn — the
  // only signal that a CHECK-violating row exists — never fired. A row this
  // broken has no meaningful recipient question to ask.
  if (invoice.memberId === null && invoice.eventRegistrationId === null) {
    logger.warn(
      {
        event: 'resend_pdf_invoice_inconsistent_buyer',
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
      },
      'resendPdf: invoice has neither member_id nor event_registration_id — cannot audit resend',
    );
    return err({ code: 'not_issued' });
  }

  // 108 FR-001 — a resend is the path most likely to run long after issue,
  // so it is the one that most needs the LIVE address: resolve it now
  // (`tx === null` — resend runs outside any financial tx, the adapter
  // self-scopes). The snapshot keeps naming the buyer on the PDF itself.
  const moneyRecipient = await resolveMoneyRecipient(
    deps.recipientLocale,
    null,
    input.tenantId,
    invoice.memberId,
    invoice.memberIdentitySnapshot,
  );
  if (moneyRecipient.kind === 'no_recipient') {
    if (invoice.memberId !== null) {
      await auditAutoEmailSkippedNoRecipient(deps.audit, null, {
        tenantId: input.tenantId,
        requestId: input.actor.requestId,
        actorUserId: input.actor.userId,
        memberId: invoice.memberId,
        emailEventType:
          input.variant === 'invoice' ? 'invoice_pdf_resent' : 'receipt_pdf_resent',
        subject: invoice.invoiceSubject,
        invoiceId: input.invoiceId,
      });
      return err({ code: 'no_recipient' });
    }
    // Round-4 finding #6 — a NON-MEMBER event buyer. Their address is the one
    // an admin typed at issue, and `create-event-invoice-draft` permits '' (the
    // snapshot's zod allows `z.literal('')`), so this is reachable. It is a
    // DIFFERENT failure from "the member has no primary contact": there is no
    // member and no member page, and `no_recipient` renders as "add or promote
    // a contact on the member page". It also left no trace at all — the audit
    // arm above needs a member to attribute to, and nothing counted the skip.
    invoicingMetrics.autoEmailSkipped(invoice.invoiceSubject, 'no_recipient');
    logger.warn(
      {
        event: 'resend_pdf_no_buyer_email',
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        variant: input.variant,
      },
      'resendPdf: non-member event buyer has no address on the frozen snapshot — nothing sent',
    );
    return err({ code: 'no_buyer_email' });
  }
  const recipientEmail = moneyRecipient.email;

  // 088 FR-030 — restore the SC/RC number to the resent audit summary + outbox
  // payload for an 088 invoice (§87 `documentNumber` NULL). Variant-aware: the
  // receipt copy names its §86/4 RC (`receiptDocumentNumberRaw`); the invoice
  // copy names its SC bill (`billDocumentNumberRaw`). Legacy §87 rows fall back
  // to `documentNumber?.raw` in both arms.
  const documentNumber =
    input.variant === 'receipt'
      ? (invoice.receiptDocumentNumberRaw ?? invoice.documentNumber?.raw ?? '')
      : (billFirstDocumentNumber(invoice) ?? '');
  const outboxEventType =
    input.variant === 'invoice' ? 'invoice_pdf_resent' : 'receipt_pdf_resent';

  // Email-locale audit 2026-07-16 — the member's language, when the caller
  // didn't pass one (no production route ever did). 108: it comes from the
  // same live primary-contact row that produced the address — one read, and
  // the two can never disagree. Non-member event buyer → undefined → 'en'.
  const recipientLocale =
    input.recipientLocale ??
    (moneyRecipient.kind === 'member' ? (moneyRecipient.locale ?? undefined) : undefined);

  // Outbox enqueue — uses PINNED templateVersion from the invoice's
  // stored PDF so the dispatcher re-signs the same Blob key rather
  // than re-rendering a drifted template (R3-E4).
  await deps.outbox.enqueue(null, {
    tenantId: input.tenantId,
    eventType: outboxEventType,
    recipientEmail,
    ...(recipientLocale ? { recipientLocale } : {}),
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
    // P2 Wave-0 (PDPA data-minimization): the `summary` column persists for the
    // audit row's FULL retention (5–10y), exactly like the payload — it is NOT
    // transient. So it must not carry plaintext PII. The hashed recipient lives
    // in `payload.recipient_email_sha256` for correlation.
    const invoiceResentSummary = `Invoice ${documentNumber} PDF resent (recipient hashed in payload)`;
    const invoiceResentPayloadBase = {
      invoice_id: input.invoiceId,
      document_number: documentNumber,
      recipient_email_sha256: recipientHash,
      actor_role: input.actor.role,
      pdf_template_version: pdf.templateVersion,
    } as const;
    // 054-event-fee-invoices — `invoice_pdf_resent` is a member-timeline event.
    //   MEMBERSHIP / matched-member (memberId non-null) → TIMELINE branch: the
    //   payload carries `member_id` so the F3 member timeline surfaces the
    //   resend (US7 / FR-033). UNCHANGED behaviour.
    //
    //   NON-MEMBER event (memberId null) → NON-timeline branch: the buyer is not
    //   an F3 member. We emit via `emitNonMemberInvoiceEvent` so the payload
    //   carries `event_registration_id` and OMITS `member_id` entirely. The
    //   former `invoice.memberId ?? ''` coalesce persisted `member_id: ''` on a
    //   timeline-typed row → the members.last_activity_at trigger cast
    //   `(payload->>'member_id')::uuid` → invalid_text_representation → silent
    //   no-op + a structurally-invalid row on the 10-year tax-document trail.
    if (invoice.memberId !== null) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.actor.requestId,
        eventType: 'invoice_pdf_resent',
        actorUserId: input.actor.userId,
        summary: invoiceResentSummary,
        payload: {
          member_id: invoice.memberId,
          ...invoiceResentPayloadBase,
        },
      });
    } else if (invoice.eventRegistrationId !== null) {
      // Non-member EVENT invoice. The DB CHECK `invoices_subject_fields_ck`
      // guarantees `event_registration_id IS NOT NULL` whenever `member_id IS
      // NULL`; TS only knows `memberId === null`, so re-narrow on the column.
      await emitNonMemberInvoiceEvent(deps.audit, null, {
        tenantId: input.tenantId,
        requestId: input.actor.requestId,
        eventType: 'invoice_pdf_resent',
        eventRegistrationId: invoice.eventRegistrationId,
        actorUserId: input.actor.userId,
        summary: invoiceResentSummary,
        extraPayload: invoiceResentPayloadBase,
      });
    } else {
      // Unreachable: the impossible-buyer row (memberId null AND
      // eventRegistrationId null) is rejected by the guard ABOVE the outbox
      // enqueue, so by the time we reach this audit block one of the two
      // branches above always applies. Kept for exhaustiveness — if it ever
      // fires, the early guard regressed; return without emitting a malformed
      // row rather than persisting one that correlates to neither a member nor
      // a registration. (The structured warn already lives at the early guard.)
      return err({ code: 'not_issued' });
    }
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

  // 108 FR-001 — a credit note follows its original invoice's buyer, so the
  // live primary of THAT member is the recipient. This arm previously had no
  // empty-recipient guard at all: it enqueued whatever the snapshot held.
  const moneyRecipient = await resolveMoneyRecipient(
    deps.recipientLocale,
    null,
    input.tenantId,
    cn.originalInvoiceMemberId,
    cn.memberIdentitySnapshot,
  );
  if (moneyRecipient.kind === 'no_recipient') {
    if (cn.originalInvoiceMemberId === null) {
      // Round-5 finding #1 — the NON-MEMBER event arm, which round 4 fixed on
      // the invoice path and left here. `no_recipient` renders as "add or
      // promote a contact on the member page"; this credit note has no member
      // and no member page. It also left no trace at all: the audit arm below
      // needs a member to attribute to, and nothing counted the skip.
      invoicingMetrics.autoEmailSkipped('unknown', 'no_recipient');
      logger.warn(
        {
          event: 'resend_pdf_no_buyer_email',
          tenantId: input.tenantId,
          creditNoteId: input.creditNoteId,
        },
        'resendPdf: non-member event buyer has no address on the credit note snapshot — nothing sent',
      );
      return err({ code: 'no_buyer_email' });
    }
    {
      await auditAutoEmailSkippedNoRecipient(deps.audit, null, {
        tenantId: input.tenantId,
        requestId: input.actor.requestId,
        actorUserId: input.actor.userId,
        memberId: cn.originalInvoiceMemberId,
        emailEventType: 'credit_note_pdf_resent',
        // Round-5 finding #7 — `subject` is 'unknown', not omitted. A
        // `CreditNote` carries no invoice subject, and omitting the label meant
        // the counter never fired for a member credit note that reached nobody,
        // while every sibling money path counts this exact condition. A guessed
        // membership/event split would be worse; an honest 'unknown' is not.
        subject: 'unknown',
        creditNoteId: input.creditNoteId,
      });
    }
    return err({ code: 'no_recipient' });
  }
  const recipientEmail = moneyRecipient.email;

  // Email-locale audit 2026-07-16 — the member's language, from the same live
  // row; non-member event CN → undefined → outbox 'en'.
  const recipientLocale =
    input.recipientLocale ??
    (moneyRecipient.kind === 'member' ? (moneyRecipient.locale ?? undefined) : undefined);

  await deps.outbox.enqueue(null, {
    tenantId: input.tenantId,
    eventType: 'credit_note_pdf_resent',
    recipientEmail,
    ...(recipientLocale ? { recipientLocale } : {}),
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
    // PDPA data-minimization (matches the invoice/receipt branches): the
    // `summary` persists for the full 5–10y audit retention, so it must NOT
    // carry plaintext PII — the hashed recipient lives in the payload.
    summary: `Credit note ${cn.documentNumber.raw} PDF resent (recipient hashed in payload)`,
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
