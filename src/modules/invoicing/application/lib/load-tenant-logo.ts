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

/**
 * Round-3 fix R3-SF3 — negative cache for permanent failures.
 *
 * Without this, a 404 (blob deleted) or permanent ACL fail causes
 * every subsequent call within a Vercel function instance lifetime
 * to retry the failing Blob fetch. F8 batched-renewal at ~131
 * invoices would burn ~131 × ~200ms = ~26s of pure waste before
 * each instance recycle.
 *
 * 60s TTL is short enough that a real fix (admin re-uploads logo,
 * cache is then keyed by the NEW UUID — the old entry just expires)
 * lands quickly, long enough to absorb a multi-invoice cron pass.
 */
const NEG_CACHE_TTL_MS = 60_000;
const NEG_CACHE_MAX = 50;
const logoNegativeCache = new Map<string, number>(); // key → expires-at epoch ms

/**
 * Round-3 fix R3-H3 — pinned-template guard for SC-003 byte-identical
 * re-render. v1 invoices that had `logo_blob_key` in their tenant
 * snapshot BUT never rendered the logo (template v1 didn't emit
 * `<Image>`) would, under v2 code, suddenly render WITH the logo →
 * sha256 mismatch vs the row's stored `pdf_sha256`. Callers re-
 * rendering a historical invoice MUST pass `pinnedTemplateVersion`
 * — when 1, this helper returns null regardless of `logoBlobKey` so
 * the re-render output stays identical to the original v1 bytes.
 *
 * NEW (issue-time) renders pass `pinnedTemplateVersion =
 * CURRENT_TEMPLATE_VERSION` (the registry's current value, ≥ 2) and the
 * helper resolves normally. Combined-mode receipts + separate-mode
 * receipts + credit notes — all render under CURRENT_TEMPLATE_VERSION at
 * issue time, so they are never the logo-less v1. Only `=== 1` returns
 * null here; every later template version (v2, v3, …) renders the logo,
 * so this comment intentionally avoids pinning a specific current number.
 */
export async function loadTenantLogo(
  blob: BlobStoragePort,
  logoBlobKey: string | null | undefined,
  pinnedTemplateVersion?: number,
): Promise<TenantLogoBytes | null> {
  if (!logoBlobKey) return null;
  // v1 had no logo rendering; preserve byte-identical re-render.
  if (pinnedTemplateVersion === 1) return null;

  const cached = logoCache.get(logoBlobKey);
  if (cached !== undefined) return cached;

  // Negative-cache check — if a recent fetch failed and the TTL is
  // still in window, skip the round-trip and return null directly.
  const negExpiresAt = logoNegativeCache.get(logoBlobKey);
  if (negExpiresAt !== undefined) {
    if (Date.now() < negExpiresAt) return null;
    logoNegativeCache.delete(logoBlobKey);
  }

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
    // Round-3 fix R3-SF5 — guard so OTel exporter throw doesn't
    // mask the logo-fetch failure (we want logger.warn to be the
    // primary signal, counter is supplementary).
    try {
      invoicingMetrics.logoLoadFailed();
    } catch {
      /* OTel emit is best-effort */
    }
    // Negative-cache the failure for NEG_CACHE_TTL_MS to short-circuit
    // subsequent calls within the same window.
    if (logoNegativeCache.size >= NEG_CACHE_MAX) {
      const oldestKey = logoNegativeCache.keys().next().value;
      if (oldestKey !== undefined) logoNegativeCache.delete(oldestKey);
    }
    logoNegativeCache.set(logoBlobKey, Date.now() + NEG_CACHE_TTL_MS);
    return null;
  }
}

/**
 * Test-only — clear the module cache (positive + negative) between
 * tests so a stale entry from test A doesn't leak into test B's
 * deterministic assertions.
 *
 * Round-3 fix R3-MED — runtime guard against accidental production
 * call. The underscore-prefix is a convention warning only; this
 * assertion is the defence-in-depth.
 */
export function _resetLogoCacheForTesting(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '_resetLogoCacheForTesting must not be called in production',
    );
  }
  logoCache.clear();
  logoNegativeCache.clear();
}
