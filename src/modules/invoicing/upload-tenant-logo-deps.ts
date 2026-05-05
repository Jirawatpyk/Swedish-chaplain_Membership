/**
 * Isolated factory for the tenant-logo-upload use-case dependencies.
 *
 * Why this file exists separately from `invoicing-deps.ts`:
 * `sharp-image-reencode-adapter` is the only F4 adapter that pulls in
 * the Node-only `sharp` native dep (libvips → detect-libc →
 * child_process). Keeping its import inside `invoicing-deps.ts` causes
 * Turbopack 16 to walk the F4 barrel re-export chain into client
 * bundles whenever a client component pulls in any other F4 use-case
 * (e.g. F8's `loadCycleDetail` → `getInvoice` → invoicing-deps), which
 * breaks the client build with "Module not found: Can't resolve
 * 'child_process'".
 *
 * Splitting `makeUploadTenantLogoDeps` into its own file confines the
 * `sharp` import to a single graph root reachable only by the
 * `/api/tenant-invoice-settings/logo` POST route — no client surface
 * ever touches it.
 */
import { vercelBlobAdapter } from './infrastructure/adapters/vercel-blob-adapter';
import { f4AuditAdapter } from './infrastructure/adapters/audit-adapter';
import { sharpImageReencodeAdapter } from './infrastructure/adapters/sharp-image-reencode-adapter';

export function makeUploadTenantLogoDeps(): {
  blob: typeof vercelBlobAdapter;
  audit: typeof f4AuditAdapter;
  imageReencode: typeof sharpImageReencodeAdapter;
} {
  return {
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    imageReencode: sharpImageReencodeAdapter,
  };
}
