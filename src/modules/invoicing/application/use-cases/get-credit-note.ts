/**
 * T080 — get-credit-note use case (F4 / US6).
 *
 * Admin/manager detail-page loader. Emits
 * `credit_note_cross_tenant_probe` on not-found so attempts to read a
 * different tenant's credit note are auditable (Constitution Principle
 * I clause 4). Members do not have a credit-note surface in US6;
 * if/when a member-portal credit-note view ships, extend the actor
 * branch here to mirror `get-invoice.ts`.
 */
import { err, ok, type Result } from '@/lib/result';
import type { CreditNoteRepo } from '../ports/credit-note-repo';
import type { AuditPort } from '../ports/audit-port';
import {
  asCreditNoteId,
  type CreditNote,
  type CreditNoteId,
} from '@/modules/invoicing/domain/credit-note';

export interface GetCreditNoteInput {
  readonly tenantId: string;
  readonly creditNoteId: string;
  readonly actor?: {
    readonly userId: string;
    readonly role: 'admin' | 'manager';
    readonly requestId: string | null;
  };
}

export type GetCreditNoteError = { code: 'not_found' };

export interface GetCreditNoteDeps {
  readonly creditNoteRepo: CreditNoteRepo;
  readonly audit: AuditPort;
}

export async function getCreditNote(
  deps: GetCreditNoteDeps,
  input: GetCreditNoteInput,
): Promise<Result<CreditNote, GetCreditNoteError>> {
  const creditNoteId: CreditNoteId = asCreditNoteId(input.creditNoteId);
  const cn = await deps.creditNoteRepo.findById(creditNoteId, input.tenantId);
  if (!cn) {
    if (input.actor) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.actor.requestId,
        eventType: 'credit_note_cross_tenant_probe',
        actorUserId: input.actor.userId,
        summary: `Probe on credit note ${creditNoteId} (not found in actor tenant)`,
        payload: {
          attempted_credit_note_id: creditNoteId,
          actor_role: input.actor.role,
          route: 'get-credit-note',
        },
      });
    }
    return err({ code: 'not_found' });
  }
  return ok(cn);
}
