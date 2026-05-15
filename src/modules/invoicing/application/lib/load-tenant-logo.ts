/**
 * Helper — load tenant logo bytes for PDF rendering.
 *
 * Called by every use-case that renders a tax document
 * (issue-invoice, issue-credit-note, record-payment,
 * render-receipt-pdf, void-invoice, preview-invoice-draft) right
 * before constructing the `PdfRenderInput.tenantLogo` field.
 *
 * Logo storage:
 *   - The tenant identity snapshot carries `logo_blob_key` — a stable
 *     key produced by the `uploadTenantLogo` use-case
 *     (`invoicing/<tenantId>/logos/<uuid>.{png|jpg}`).
 *   - This helper turns that key into the actual bytes by reading
 *     them out of Vercel Blob.
 *
 * Why a discrete helper (not inside the adapter):
 *   - Clean-architecture: the PDF render port stays pure (input ➜
 *     output) and the Application layer owns the I/O choreography.
 *   - Determinism: bytes are immutable in Blob, so seed-input stays
 *     stable across re-renders.
 *
 * Resilience:
 *   - Logo fetch failures are non-fatal. We log + fall back to a
 *     no-logo render so an outage of the Blob endpoint does not block
 *     legal-document issuance.
 */
import type { BlobStoragePort } from '../ports/blob-storage-port';
import { logger } from '@/lib/logger';

export interface TenantLogoBytes {
  readonly bytes: Uint8Array;
  readonly format: 'png' | 'jpg';
}

export async function loadTenantLogo(
  blob: BlobStoragePort,
  logoBlobKey: string | null | undefined,
): Promise<TenantLogoBytes | null> {
  if (!logoBlobKey) return null;
  const lower = logoBlobKey.toLowerCase();
  const format: 'png' | 'jpg' = lower.endsWith('.png') ? 'png' : 'jpg';
  try {
    const bytes = await blob.downloadBytes(logoBlobKey);
    return { bytes, format };
  } catch (err) {
    logger.warn(
      { err, logoBlobKey },
      'loadTenantLogo: failed to fetch logo bytes — rendering without logo',
    );
    return null;
  }
}
