/**
 * F119 R17 — `list-member-broadcast-images.ts` Application use-case.
 *
 * Every image uploaded for the E-Blasts the member originated, for the F9
 * GDPR archive (research R17: "every image uploaded for the E-Blast"). Live
 * AND stamped rows — a stamped row is still the record of an upload. Newest
 * first; the caller passes one past its cap to detect truncation.
 *
 * The projection is what leaves this module, so it decides what the archive
 * can carry:
 *   - no uploader user id — the archive never names a user (the F114
 *     `decidedBy: 'organisation'` precedent);
 *   - `blobUrl` ONLY while the image is live — a stamped image's URL is about
 *     to be reclaimed by the sweep and must not be re-published.
 */
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { BroadcastImagesRepo } from '../ports/broadcast-images-repo';
import type { ImageMimeType } from '../ports/image-storage-port';

export interface ListMemberBroadcastImagesDeps {
  readonly tenant: TenantContext;
  readonly imagesRepo: BroadcastImagesRepo;
}

export interface ListMemberBroadcastImagesInput {
  readonly memberId: MemberId;
  /** Maximum rows returned (pass cap + 1 to detect truncation). */
  readonly limit: number;
}

export interface MemberBroadcastImage {
  readonly imageId: string;
  readonly broadcastId: string;
  readonly contentHash: string;
  readonly mimeType: ImageMimeType;
  readonly byteSize: number;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
  /** Present only while the image is live (`deletedAt === null`). */
  readonly blobUrl?: string;
}

export async function listMemberBroadcastImages(
  deps: ListMemberBroadcastImagesDeps,
  input: ListMemberBroadcastImagesInput,
): Promise<readonly MemberBroadcastImage[]> {
  const slug = deps.tenant.slug;
  const rows = await deps.imagesRepo.withTx(slug, (tx) =>
    deps.imagesRepo.listByMember(slug, input.memberId, input.limit, tx),
  );
  return rows.map((r) => ({
    imageId: r.id,
    broadcastId: r.ownerId,
    contentHash: r.contentHash,
    mimeType: r.mimeType,
    byteSize: r.byteSize,
    createdAt: r.createdAt,
    deletedAt: r.deletedAt,
    ...(r.deletedAt === null ? { blobUrl: r.blobUrl } : {}),
  }));
}
