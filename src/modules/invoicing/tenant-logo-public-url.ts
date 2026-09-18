/**
 * F119 T027 — module-root binding of `makeGetTenantLogoPublicUrl` to the
 * production F4 adapters. Kept out of `application/lib/` (which stays pure)
 * and out of `index.ts`'s import graph concerns: it pulls only the Drizzle
 * settings repo and the Vercel Blob adapter, both of which the barrel
 * already exports.
 */
import { makeGetTenantLogoPublicUrl } from './application/lib/tenant-logo-public-url';
import { vercelBlobAdapter } from './infrastructure/adapters/vercel-blob-adapter';
import { drizzleTenantSettingsRepo } from './infrastructure/repos/drizzle-tenant-settings-repo';

export const getTenantLogoPublicUrl = makeGetTenantLogoPublicUrl({
  settings: drizzleTenantSettingsRepo,
  blob: vercelBlobAdapter,
});
