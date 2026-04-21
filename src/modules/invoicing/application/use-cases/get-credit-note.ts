/**
 * T080 — get-credit-note use case (F4 / US6).
 *
 * Admin/manager detail-page loader. Emits
 * `credit_note_cross_tenant_probe` on not-found so attempts to read a
 * different tenant's credit note are auditable (Constitution Principle
 * I clause 4).
 *
 * G-1 (2026-04-21) — member actor variant added. When the caller is a
 * portal member, the repo returns only the actor's own tenant's rows
 * (RLS) AND the use-case enforces that the CN's original invoice
 * belongs to the actor's `memberId`. Mismatch is treated opaquely as
 * `not_found` (same shape as cross-tenant probe — do not leak which
 * member owns an unknown CN) but still audit-logged.
 */
import { err, ok, type Result } from '@/lib/result';
import type { CreditNoteRepo } from '../ports/credit-note-repo';
import type { AuditPort } from '../ports/audit-port';
import {
  asCreditNoteId,
  type CreditNote,
  type CreditNoteId,
} from '@/modules/invoicing/domain/credit-note';

export type GetCreditNoteActor =
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

export interface GetCreditNoteInput {
  readonly tenantId: string;
  readonly creditNoteId: string;
  readonly actor?: GetCreditNoteActor;
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

  // G-1 — member ownership check. Members may only view credit notes
  // whose original invoice they own. Mismatch → treat as `not_found`
  // (same opacity as cross-tenant probe so an attacker cannot
  // enumerate other members' CN ids by status-code probing) + audit.
  if (input.actor?.role === 'member') {
    if (cn.originalInvoiceMemberId !== input.actor.memberId) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.actor.requestId,
        eventType: 'credit_note_cross_tenant_probe',
        actorUserId: input.actor.userId,
        summary: `Member ownership mismatch on credit note ${creditNoteId}`,
        payload: {
          attempted_credit_note_id: creditNoteId,
          actor_role: 'member',
          attempted_member_id: input.actor.memberId,
          route: 'get-credit-note',
        },
      });
      return err({ code: 'not_found' });
    }
  }

  return ok(cn);
}
