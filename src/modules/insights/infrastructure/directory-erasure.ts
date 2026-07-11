/**
 * COMP-1 / GDPR Art.17 / PDPA §33 — erase a member's insights-owned FOOTPRINT.
 *
 * Two concerns, both insights-owned tables the members erasure cascade cannot
 * reach directly (it calls this via the members `DirectoryErasurePort` adapter):
 *
 *  1. DIRECTORY — the `directory_listings` row (member-authored PII:
 *     description/website/industry/location) + the PUBLIC logo blob (a
 *     publicly-fetchable artefact). The directory read paths only gate
 *     `erased_at IS NULL` (suppressing FUTURE publication) — they do not delete
 *     the stored data or the uploaded blob. Blob-before-row ordering keeps it
 *     re-drive-safe: the logo URL is only discoverable while the row survives.
 *
 *  2. GDPR EXPORT ARTEFACTS (I-7) — the member's own `gdpr_member_archive`
 *     export jobs snapshot their full pre-erasure data. Delete each artefact's
 *     private blob + expire the job (`markExpiredInTx` nulls the single-use
 *     download token) so the archive cannot be downloaded post-erasure — rather
 *     than waiting up to the ~1h TTL sweep. Directory-WIDE exports
 *     (`directory_json` / `directory_ebook`) are NOT per-member (they snapshot
 *     every opted-in member), so they are left to the TTL sweep +
 *     regeneration-without-the-erased-member, not force-deleted here.
 *
 * Throws on any DB/blob failure so the members cascade records the outcome as
 * incomplete (member_erased withheld → US2d reconciler re-drives). Every step is
 * idempotent + re-drive-safe.
 */
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { makeDrizzleDirectoryRepo } from './repos/drizzle-directory-repo';
import { makeDrizzleExportJobRepo } from './repos/drizzle-export-job-repo';
import { publicLogoBlobAdapter } from './logo/public-logo-blob-adapter';
import { privateBlobAdapter } from './blob/private-blob-adapter';

// A member holds at most a handful of live GDPR archives (older ones are
// TTL-expired — blob gone — then purged); a generous bound covers the live set.
const GDPR_ARCHIVE_SCAN_LIMIT = 100;

export async function eraseMemberInsightsFootprint(
  ctx: TenantContext,
  memberId: string,
): Promise<void> {
  // 1. Directory listing + public logo (blob-before-row, re-drive-safe).
  const directoryRepo = makeDrizzleDirectoryRepo(ctx.slug);
  const listing = await directoryRepo.findByMemberId(ctx, memberId);
  if (listing?.logoUrl) {
    await publicLogoBlobAdapter.deleteLogo(listing.logoUrl);
  }
  await runInTenant(ctx, (tx) => directoryRepo.deleteForMemberInTx(tx, memberId));

  // 2. GDPR export artefacts (I-7) — invalidate the member's own archives now.
  const exportRepo = makeDrizzleExportJobRepo(ctx.slug);
  const archives = await exportRepo.listRecentForSubject(
    ctx,
    memberId,
    'gdpr_member_archive',
    GDPR_ARCHIVE_SCAN_LIMIT,
  );
  for (const job of archives) {
    // Delete the private blob first (idempotent), then expire the job — which
    // nulls the single-use download token (markExpiredInTx is guarded to
    // ready|delivered). Mirrors the TTL sweep's order + is re-drive-safe.
    if (job.blobKey) {
      await privateBlobAdapter.delete(job.blobKey);
    }
    await runInTenant(ctx, (tx) => exportRepo.markExpiredInTx(tx, job.id));
  }
}
