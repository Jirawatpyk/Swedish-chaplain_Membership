/**
 * #60 — the post-rollback orphan-PDF delete shared by `recordPayment`,
 * `issueInvoice` and `issueEventInvoiceAsPaid`.
 *
 * Each of them uploads a PDF to a deterministic key inside its transaction.
 * When a step after the upload fails, the transaction rolls back but the
 * bytes stay, so the catch deletes them. Deleting naively had three races:
 *
 *   - an ambiguous COMMIT (the commit landed, its acknowledgement was lost)
 *     deleted a committed document's file;
 *   - the next attempt queued on the row lock could upload and commit before
 *     the delete arrived, and lose its file;
 *   - a delete that timed out client-side could still be applied by Blob
 *     after a successor's overwrite.
 *
 * So this re-reads the invoice `FOR UPDATE` in a short transaction, keeps
 * the file when the row points at the key, and otherwise deletes while
 * holding the lock, conditional on the etag this attempt uploaded.
 *
 * Inside a caller-owned transaction (`externalTx`: F5 webhook, F8 offline
 * mark) the re-read runs on that transaction: it sees the attempt's own
 * uncommitted row (kept: the next attempt's overwrite is the net), or fails
 * when the caller's transaction is already aborted. That failure is
 * reported as `OrphanCleanupLockReadError`, separately from a failed delete,
 * because it says nothing about Blob.
 */
import type { InvoiceRepo } from '../ports/invoice-repo';
import { BlobChangedSinceUploadError, type BlobStoragePort } from '../ports/blob-storage-port';
import type { Invoice, InvoiceId } from '../../domain/invoice';

export class OrphanCleanupLockReadError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super('orphan cleanup: the locked re-read of the invoice failed', options);
    this.name = 'OrphanCleanupLockReadError';
  }
}

export type OrphanCleanupOutcome = 'deleted' | 'kept_row_owns_key' | 'kept_changed_since_upload';

export async function deleteOrphanPdfUnderLock(
  deps: {
    readonly invoiceRepo: Pick<InvoiceRepo, 'withTx' | 'findByIdInTxForUpdate'>;
    readonly blob: Pick<BlobStoragePort, 'delete'>;
  },
  args: {
    readonly invoiceId: InvoiceId;
    readonly tenantId: string;
    readonly blobKey: string;
    /** The etag this attempt's upload returned, or null when unknown. */
    readonly etag: string | null;
    /** Whether the (locked) row references `blobKey` as its document. */
    readonly rowOwnsKey: (row: Invoice) => boolean;
  },
): Promise<OrphanCleanupOutcome> {
  // A failure before the delete is attempted (opening the tx, the locked
  // read) is a database problem, not a Blob one.
  let deleteAttempted = false;
  try {
    return await deps.invoiceRepo.withTx(async (tx) => {
      const row = await deps.invoiceRepo.findByIdInTxForUpdate(tx, args.invoiceId, args.tenantId);
      if (row && args.rowOwnsKey(row)) return 'kept_row_owns_key' as const;
      deleteAttempted = true;
      try {
        if (args.etag !== null) {
          await deps.blob.delete(args.blobKey, { ifMatch: args.etag });
        } else {
          await deps.blob.delete(args.blobKey);
        }
      } catch (e) {
        if (e instanceof BlobChangedSinceUploadError) return 'kept_changed_since_upload' as const;
        throw e;
      }
      return 'deleted' as const;
    });
  } catch (e) {
    if (!deleteAttempted) throw new OrphanCleanupLockReadError({ cause: e });
    throw e;
  }
}
