/**
 * T080 — get-credit-note-pdf-signed-url use case (F4 / US6).
 *
 * Mirror of `get-invoice-pdf-signed-url` for credit notes. 60 s signed
 * URL, probe audit on not-found. Admin/manager scope only in US6 MVP.
 */
import { err, ok, type Result } from '@/lib/result';
import type { CreditNoteRepo } from '../ports/credit-note-repo';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { AuditPort } from '../ports/audit-port';
import {
  asCreditNoteId,
  type CreditNoteId,
} from '@/modules/invoicing/domain/credit-note';

export interface GetCreditNotePdfSignedUrlInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actorRole: 'admin' | 'manager';
  readonly requestId?: string | null;
  readonly creditNoteId: string;
}

export type GetCreditNotePdfSignedUrlError =
  | { code: 'credit_note_not_found' }
  | { code: 'blob_missing'; key: string };

export interface GetCreditNotePdfSignedUrlDeps {
  readonly creditNoteRepo: CreditNoteRepo;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
}

export async function getCreditNotePdfSignedUrl(
  deps: GetCreditNotePdfSignedUrlDeps,
  input: GetCreditNotePdfSignedUrlInput,
): Promise<
  Result<
    { url: string; filename: string },
    GetCreditNotePdfSignedUrlError
  >
> {
  const creditNoteId: CreditNoteId = asCreditNoteId(input.creditNoteId);
  const cn = await deps.creditNoteRepo.findById(creditNoteId, input.tenantId);
  if (!cn) {
    await deps.audit.emit(null, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'credit_note_cross_tenant_probe',
      actorUserId: input.actorUserId,
      summary: `Probe on credit note ${creditNoteId} (not found in actor tenant)`,
      payload: {
        attempted_credit_note_id: creditNoteId,
        actor_role: input.actorRole,
        route: 'get-credit-note-pdf-signed-url',
      },
    });
    return err({ code: 'credit_note_not_found' });
  }

  const url = await deps.blob.signDownloadUrl(cn.pdf.blobKey, 60);
  const filename = `${cn.documentNumber.raw}.pdf`;
  return ok({ url, filename });
}
