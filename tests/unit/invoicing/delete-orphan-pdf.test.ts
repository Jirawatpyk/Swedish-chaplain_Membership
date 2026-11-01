/**
 * #60 review — the shared post-rollback orphan-PDF delete used by
 * recordPayment, issueInvoice and issueEventInvoiceAsPaid.
 *
 * It deletes only while holding the invoice row lock (so the next lock
 * waiter's upload lands after the delete), keeps the file when the locked
 * re-read shows a row pointing at the key (an ambiguous COMMIT), deletes
 * conditionally on the etag this attempt uploaded (so a delete Blob applies
 * late cannot remove a successor's bytes), and reports a failed lock read
 * separately from a failed delete.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  deleteOrphanPdfUnderLock,
  OrphanCleanupLockReadError,
} from '@/modules/invoicing/application/lib/delete-orphan-pdf';
import { BlobChangedSinceUploadError } from '@/modules/invoicing/application/ports/blob-storage-port';
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';

const KEY = 'invoicing/t/2026/inv_receipt_v1.pdf';
const INVOICE_ID = asInvoiceId('00000000-0000-0000-0000-00000000e0aa');

function deps(row: Partial<Invoice> | null, order: string[] = []) {
  const tx = { tag: 'cleanup-tx' };
  return {
    invoiceRepo: {
      withTx: vi.fn(async <T,>(fn: (t: unknown) => Promise<T>) => {
        order.push('tx-open');
        const out = await fn(tx);
        order.push('tx-close');
        return out;
      }),
      findByIdInTxForUpdate: vi.fn(async () => {
        order.push('locked-read');
        return row as Invoice | null;
      }),
    },
    blob: {
      delete: vi.fn(async () => {
        order.push('delete');
      }),
    },
  };
}

const ownsReceipt = (r: Invoice) => r.receiptPdf?.blobKey === KEY;

describe('deleteOrphanPdfUnderLock', () => {
  it('a row pointing at the key (ambiguous COMMIT / a successor) → kept, nothing deleted', async () => {
    const d = deps({ receiptPdf: { blobKey: KEY } } as unknown as Partial<Invoice>);
    const r = await deleteOrphanPdfUnderLock(d, {
      invoiceId: INVOICE_ID,
      tenantId: 't',
      blobKey: KEY,
      etag: null,
      rowOwnsKey: ownsReceipt,
    });
    expect(r).toBe('kept_row_owns_key');
    expect(d.blob.delete).not.toHaveBeenCalled();
  });

  it('no owner → deletes INSIDE the locked tx, conditional on the uploaded etag', async () => {
    const order: string[] = [];
    const d = deps(null, order);
    const r = await deleteOrphanPdfUnderLock(d, {
      invoiceId: INVOICE_ID,
      tenantId: 't',
      blobKey: KEY,
      etag: '"etag-a"',
      rowOwnsKey: ownsReceipt,
    });
    expect(r).toBe('deleted');
    expect(order).toEqual(['tx-open', 'locked-read', 'delete', 'tx-close']);
    expect(d.blob.delete).toHaveBeenCalledWith(KEY, { ifMatch: '"etag-a"' });
  });

  it('no etag (upload failed mid-way) → unconditional delete under the lock', async () => {
    const d = deps(null);
    await deleteOrphanPdfUnderLock(d, {
      invoiceId: INVOICE_ID,
      tenantId: 't',
      blobKey: KEY,
      etag: null,
      rowOwnsKey: ownsReceipt,
    });
    expect(d.blob.delete).toHaveBeenCalledWith(KEY);
  });

  it('the bytes changed since this upload (etag mismatch) → kept', async () => {
    const d = deps(null);
    d.blob.delete = vi.fn(async () => {
      throw new BlobChangedSinceUploadError();
    });
    const r = await deleteOrphanPdfUnderLock(d, {
      invoiceId: INVOICE_ID,
      tenantId: 't',
      blobKey: KEY,
      etag: '"etag-a"',
      rowOwnsKey: ownsReceipt,
    });
    expect(r).toBe('kept_changed_since_upload');
  });

  it('a failed locked read (aborted caller tx / DB down) rejects as OrphanCleanupLockReadError, no delete', async () => {
    const d = deps(null);
    d.invoiceRepo.findByIdInTxForUpdate = vi.fn(async () => {
      throw new Error('current transaction is aborted');
    });
    await expect(
      deleteOrphanPdfUnderLock(d, {
        invoiceId: INVOICE_ID,
        tenantId: 't',
        blobKey: KEY,
        etag: null,
        rowOwnsKey: ownsReceipt,
      }),
    ).rejects.toBeInstanceOf(OrphanCleanupLockReadError);
    expect(d.blob.delete).not.toHaveBeenCalled();
  });

  it('a failed delete rejects with the delete error itself (the caller counts it)', async () => {
    const d = deps(null);
    const boom = new Error('blob 500');
    d.blob.delete = vi.fn(async () => {
      throw boom;
    });
    await expect(
      deleteOrphanPdfUnderLock(d, {
        invoiceId: INVOICE_ID,
        tenantId: 't',
        blobKey: KEY,
        etag: null,
        rowOwnsKey: ownsReceipt,
      }),
    ).rejects.toBe(boom);
  });
});
