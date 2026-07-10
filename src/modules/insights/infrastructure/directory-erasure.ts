/**
 * COMP-1 / GDPR Art.17 / PDPA §33 — erase a member's insights DIRECTORY
 * footprint.
 *
 * The `directory_listings` row holds member-authored PII (description, website,
 * industry, location) and the public logo BLOB is a publicly-fetchable
 * artefact. Member erasure must remove BOTH: the read-path `erased_at IS NULL`
 * guard only suppresses FUTURE publication — it does not delete the stored data
 * or the already-uploaded blob. This is the single insights-owned crossing the
 * members erasure cascade calls (via the members `DirectoryErasurePort`
 * adapter) so `directory_listings` + the logo store stay encapsulated here.
 *
 * Re-drive-safe ordering (blob BEFORE row): the logo URL is only discoverable
 * while the row survives, so the blob is deleted first and the row last. If the
 * blob delete fails, the row (hence the URL) remains for the US2d reconciler to
 * re-drive; if the row delete fails after a successful blob delete, a re-drive
 * re-reads the URL and the idempotent blob delete is a harmless no-op.
 *
 * Throws on any DB/blob failure so the members cascade records the outcome as
 * incomplete (member_erased withheld → reconciler re-drives).
 */
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { makeDrizzleDirectoryRepo } from './repos/drizzle-directory-repo';
import { publicLogoBlobAdapter } from './logo/public-logo-blob-adapter';

export async function eraseMemberDirectoryFootprint(
  ctx: TenantContext,
  memberId: string,
): Promise<void> {
  const repo = makeDrizzleDirectoryRepo(ctx.slug);
  const listing = await repo.findByMemberId(ctx, memberId);
  if (listing?.logoUrl) {
    await publicLogoBlobAdapter.deleteLogo(listing.logoUrl);
  }
  await runInTenant(ctx, (tx) => repo.deleteForMemberInTx(tx, memberId));
}
