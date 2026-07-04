/**
 * 088 US8 UX-B2 (T061f) — Zero-rate cert-scan prune repo port (F4).
 *
 * The single read the orphaned-cert TTL sweep needs: does ANY invoice row (in
 * this tenant, ANY status) pin a given §80/1(5) cert-scan blob key onto its
 * `zero_rate_cert_blob_key` column? A pinned cert is 10-year-retained legal
 * evidence and MUST NEVER be swept, even on a voided / credited invoice — this
 * probe is the sweep's KEEP gate.
 *
 * Deliberately a SEPARATE, single-method port (not a method on the main
 * `InvoiceRepo`) so the sweep's admin-bypass wiring does not force a signature
 * change onto the ~15 existing full-literal `InvoiceRepo` test mocks
 * (Constitution X — minimise blast radius).
 *
 * Threaded per the F6 sweep pattern: the composition root opens a per-tenant
 * `runInTenant(asTenantContext(tenantId), tx => makeDrizzleZeroRateCertPruneRepo(tx))`
 * so RLS scopes the probe to the key's tenant (defence-in-depth alongside the
 * explicit `tenant_id` filter).
 */
export interface ZeroRateCertPruneRepo {
  /**
   * `true` iff some invoice in `tenantId` (any status) has
   * `zero_rate_cert_blob_key = blobKey`. The `tenantId` arg is the explicit
   * WHERE filter alongside RLS (mirrors F6's `clearErrorCsvBlob(tenantId, …)`).
   */
  existsInvoiceWithCertBlobKey(
    tenantId: string,
    blobKey: string,
  ): Promise<boolean>;
}
