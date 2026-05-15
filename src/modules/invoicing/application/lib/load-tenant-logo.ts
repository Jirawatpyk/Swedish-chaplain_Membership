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
import { invoicingMetrics } from '@/lib/metrics';

export interface TenantLogoBytes {
  readonly bytes: Uint8Array;
  readonly format: 'png' | 'jpg';
}

/**
 * In-process LRU-ish cache for logo bytes. Key = blob key (uniquely
 * content-addressed by `uploadTenantLogo` — the random UUID suffix
 * means a new upload produces a new key, so cached entries for the
 * OLD key naturally become unreachable without explicit invalidation).
 *
 * Why an in-process cache:
 *   - F8 batched renewal (auto-issue invoices for ~131 SweCham members
 *     in a single cron pass) would call `loadTenantLogo` 131 times
 *     against the same tenant logo. The Blob fetch (~50-150ms each)
 *     dominates render latency at scale.
 *   - Logo bytes are immutable per blob key (content-addressed via
 *     UUID), so caching is safe — no staleness window.
 *   - Bounded by Map size cap (50 entries) to prevent unbounded growth
 *     on multi-tenant deployments. Eviction is FIFO via Map iteration
 *     order — Map preserves insertion order in V8 / Node.
 *
 * The cache lives at module scope so it's shared across requests on
 * the same Vercel Function instance (Fluid Compute reuses instances).
 * Cleared automatically when the instance is recycled.
 */
const LOGO_CACHE_MAX = 50;
const logoCache = new Map<string, TenantLogoBytes>();

export async function loadTenantLogo(
  blob: BlobStoragePort,
  logoBlobKey: string | null | undefined,
): Promise<TenantLogoBytes | null> {
  if (!logoBlobKey) return null;

  const cached = logoCache.get(logoBlobKey);
  if (cached !== undefined) return cached;

  const lower = logoBlobKey.toLowerCase();
  const format: 'png' | 'jpg' = lower.endsWith('.png') ? 'png' : 'jpg';
  try {
    const bytes = await blob.downloadBytes(logoBlobKey);
    const result: TenantLogoBytes = { bytes, format };

    // FIFO eviction — pop oldest entry when cap reached.
    if (logoCache.size >= LOGO_CACHE_MAX) {
      const oldestKey = logoCache.keys().next().value;
      if (oldestKey !== undefined) logoCache.delete(oldestKey);
    }
    logoCache.set(logoBlobKey, result);
    return result;
  } catch (err) {
    logger.warn(
      { err, logoBlobKey },
      'loadTenantLogo: failed to fetch logo bytes — rendering without logo',
    );
    // OTel counter for ops alerting — sustained non-zero rate per
    // tenant indicates expired blob key or misconfigured upload.
    invoicingMetrics.logoLoadFailed();
    return null;
  }
}

/**
 * Test-only — clear the module cache between tests so a stale entry
 * from test A doesn't leak into test B's deterministic assertions.
 */
export function _resetLogoCacheForTesting(): void {
  logoCache.clear();
}
