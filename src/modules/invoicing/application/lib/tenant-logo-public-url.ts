/**
 * F119 T027 (research R12, FR-041a/b) — READ-only public URL of the chamber
 * logo already on file for invoices.
 *
 * The E-Blast email header shows the same logo the tax documents carry:
 * ONE artefact, set once on the invoice-settings page (super-admin only,
 * `settings.invoicing`), used in both places. This helper only resolves the
 * public Vercel Blob URL of `tenant_invoice_settings.logo_blob_key` — it has
 * no write surface, and the broadcasts module reaches it through the
 * invoicing barrel behind its own `TenantLogoUrlPort`.
 *
 * Fail-soft: any miss (no settings row, no logo key, blob resolution
 * failure) is `null`, and the caller renders the chamber name exactly as
 * before F119. Never throws into an email render.
 *
 * Caches mirror `loadTenantLogo` (`./load-tenant-logo.ts`): a bounded FIFO
 * positive cache keyed by the blob key (a re-upload mints a new UUID key,
 * so a stale entry is simply never asked for again) and a 60 s negative
 * cache keyed by tenant so a deleted blob does not cost a round-trip per
 * preview render. Module scope — shared across requests on one Fluid
 * Compute instance, dropped when the instance recycles.
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';

const URL_CACHE_MAX = 50;
const NEG_CACHE_TTL_MS = 60_000;
const NEG_CACHE_MAX = 50;

const urlByBlobKey = new Map<string, string>();
const negativeByTenant = new Map<string, number>(); // tenantId → expires-at epoch ms

export interface TenantLogoPublicUrlDeps {
  readonly settings: Pick<TenantSettingsRepo, 'getForIssue'>;
  readonly blob: Pick<BlobStoragePort, 'signDownloadUrl'>;
}

function fifoSet<K, V>(map: Map<K, V>, max: number, key: K, value: V): void {
  if (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Bind the ports once; the barrel exports the bound function. */
export function makeGetTenantLogoPublicUrl(
  deps: TenantLogoPublicUrlDeps,
): (tenantId: string) => Promise<string | null> {
  return async function getTenantLogoPublicUrl(tenantId: string): Promise<string | null> {
    const negExpiresAt = negativeByTenant.get(tenantId);
    if (negExpiresAt !== undefined) {
      if (Date.now() < negExpiresAt) return null;
      negativeByTenant.delete(tenantId);
    }
    try {
      const settings = await deps.settings.getForIssue(tenantId);
      const key = settings?.identity.logo_blob_key ?? null;
      if (key === null) return null;
      const cached = urlByBlobKey.get(key);
      if (cached !== undefined) return cached;
      const url = await deps.blob.signDownloadUrl(key);
      fifoSet(urlByBlobKey, URL_CACHE_MAX, key, url);
      return url;
    } catch (e) {
      // A DB read or a blob `head()` can throw; the key itself is a tenant
      // path segment and is deliberately not logged.
      logger.warn({ err: errKind(e), tenantId }, 'invoicing.tenant_logo_public_url.unresolved');
      fifoSet(negativeByTenant, NEG_CACHE_MAX, tenantId, Date.now() + NEG_CACHE_TTL_MS);
      return null;
    }
  };
}

/** Test-only — clear both caches so one test's entry cannot leak into the next. */
export function _resetTenantLogoUrlCacheForTesting(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('_resetTenantLogoUrlCacheForTesting must not be called in production');
  }
  urlByBlobKey.clear();
  negativeByTenant.clear();
}
