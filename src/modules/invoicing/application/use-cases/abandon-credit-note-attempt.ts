/**
 * Task 68 — "Start over" on a locked admin credit-note attempt.
 *
 * After an unknown outcome the admin form keeps its attempt (an idempotency
 * key, #66) locked: the original request may still be running and commit a
 * §86/10 note. Unlocking on the client alone could therefore let a second
 * note be issued. This use case decides on the server, under the SAME invoice
 * `FOR UPDATE` lock every issue attempt takes:
 *
 *   - a note already issued under the key → answered `issued`, nothing closed;
 *   - otherwise a tombstone closes the key for good (`issueCreditNote` refuses
 *     a later request with it as `attempt_abandoned`) and one audit row says
 *     so → answered `abandoned`.
 *
 * The lock is the guarantee: an attempt that holds it commits first and is
 * found here; one that reaches it later finds the tombstone. A second call is
 * idempotent. A key that answers another invoice is a client bug: refused.
 */
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import type { CreditNote } from '../../domain/credit-note';
import { asInvoiceId } from '../../domain/invoice';
import type { AuditPort } from '../ports/audit-port';
import type { CreditNoteRepo } from '../ports/credit-note-repo';
import type { InvoiceRepo } from '../ports/invoice-repo';

export const abandonCreditNoteAttemptSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
});

export type AbandonCreditNoteAttemptInput = z.infer<typeof abandonCreditNoteAttemptSchema>;

export type AbandonCreditNoteAttemptSuccess =
  | { readonly outcome: 'abandoned' }
  | { readonly outcome: 'issued'; readonly creditNote: CreditNote };

export type AbandonCreditNoteAttemptError =
  | { readonly code: 'invoice_not_found' }
  | { readonly code: 'concurrent_state_change' };

export interface AbandonCreditNoteAttemptDeps {
  readonly invoiceRepo: Pick<InvoiceRepo, 'withTx' | 'lockForUpdate'>;
  readonly creditNoteRepo: Pick<
    CreditNoteRepo,
    'findByIdempotencyKey' | 'findAbandonedAttempt' | 'insertAbandonedAttempt'
  >;
  readonly audit: AuditPort;
}

export async function abandonCreditNoteAttempt(
  deps: AbandonCreditNoteAttemptDeps,
  input: AbandonCreditNoteAttemptInput,
): Promise<Result<AbandonCreditNoteAttemptSuccess, AbandonCreditNoteAttemptError>> {
  const invoiceId = asInvoiceId(input.invoiceId);
  return deps.invoiceRepo.withTx(async (tx) => {
    // The same lock every issue attempt on this invoice holds while it runs.
    const status = await deps.invoiceRepo.lockForUpdate(tx, invoiceId, input.tenantId);
    if (status === null) return err({ code: 'invoice_not_found' as const });

    const note = await deps.creditNoteRepo.findByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
    if (note) {
      if (note.originalInvoiceId !== invoiceId) return err({ code: 'concurrent_state_change' as const });
      return ok({ outcome: 'issued' as const, creditNote: note });
    }

    const tombstone = await deps.creditNoteRepo.findAbandonedAttempt(tx, input.tenantId, input.idempotencyKey);
    if (tombstone) {
      if (tombstone.invoiceId !== invoiceId) return err({ code: 'concurrent_state_change' as const });
      return ok({ outcome: 'abandoned' as const });
    }

    await deps.creditNoteRepo.insertAbandonedAttempt(tx, {
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      invoiceId,
      abandonedByUserId: input.actorUserId,
    });
    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'credit_note_attempt_abandoned',
      actorUserId: input.actorUserId,
      summary: 'A credit-note issue attempt was closed with Start over; no note was issued',
      payload: { invoice_id: invoiceId, idempotency_key: input.idempotencyKey },
    });
    return ok({ outcome: 'abandoned' as const });
  });
}
