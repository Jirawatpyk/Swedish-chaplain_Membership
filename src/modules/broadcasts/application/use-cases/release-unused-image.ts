/**
 * Spec 131 (layer 1) — `releaseUnusedImage`: the author uploaded an image and
 * then cancelled its description, so it was never put in the message. Before
 * this, its row stayed live and its bytes stayed at a public, unauthenticated
 * URL until the E-Blast was retention-deleted, about five years later.
 *
 * WHO. Exactly where the upload was allowed: `authorizeImageOwner`, reused
 * unchanged (a member's own `draft`; staff on `draft | submitted | in_design`
 * or a template). A refusal is its `not_found` (404 + probe audit) or
 * `closed` (409), and nothing is stamped.
 *
 * WHAT. One live row of THAT owner is stamped, and
 * `broadcast_image_removed { reason: 'not_inserted', blob_deleted: false }`
 * is audited in the same transaction. The emit is raw (through
 * `auditImagesRemoved`), so a failed audit rolls the stamp back rather than
 * commit an unevidenced deletion. No live row of that owner with that id
 * (already stamped, another owner's, unknown) → `released: false` and no
 * audit: a repeated release is harmless and says nothing about other rows.
 *
 * NO CONTENT CHECK. The bytes are not touched here. The next daily sweep's
 * marked arm applies the last-reference rule, and when live content still
 * embeds the URL (the same file inserted earlier, deduped to the same URL)
 * it keeps the bytes and puts the row back live (`restoreLive`, ROUND-2 S-3).
 * A release therefore cannot remove an image the message uses.
 *
 * Pure Application — only ports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastImageOwnerKind, BroadcastImagesRepo } from '../ports/broadcast-images-repo';
import { auditImagesRemoved } from './_mark-owner-images-removed';
import {
  authorizeImageOwner,
  type AuthorizeImageOwnerDeps,
  type AuthorizeImageOwnerError,
  type ImageUploadActor,
} from './authorize-image-owner';

export interface ReleaseUnusedImageDeps {
  readonly imagesRepo: Pick<BroadcastImagesRepo, 'withTx' | 'markDeletedById'>;
  readonly audit: AuditPort;
  /** The upload's own ownership check, reused unchanged. */
  readonly owner: AuthorizeImageOwnerDeps;
}

export interface ReleaseUnusedImageInput {
  readonly tenantId: TenantSlug;
  readonly owner: { readonly kind: BroadcastImageOwnerKind; readonly id: string };
  readonly imageId: string;
  readonly actor: ImageUploadActor;
  readonly actorUserId: string;
  /** The session role. NEVER a literal stand-in (`check:actor-role-truth`). */
  readonly actorRole: string | null;
  readonly requestId: string;
  readonly now: Date;
}

export interface ReleaseUnusedImageOutput {
  readonly released: boolean;
}

export async function releaseUnusedImage(
  deps: ReleaseUnusedImageDeps,
  input: ReleaseUnusedImageInput,
): Promise<Result<ReleaseUnusedImageOutput, AuthorizeImageOwnerError>> {
  const authorized = await authorizeImageOwner(deps.owner, {
    tenantId: input.tenantId as never,
    owner: input.owner,
    actor: input.actor,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
  });
  if (!authorized.ok) return err(authorized.error);

  return deps.imagesRepo.withTx(input.tenantId, async (tx) => {
    const stamped = await deps.imagesRepo.markDeletedById(input.tenantId, input.owner, input.imageId, input.now, tx);
    if (stamped === null) return ok({ released: false });
    await auditImagesRemoved(
      deps.audit,
      {
        tenantId: input.tenantId,
        reason: 'not_inserted',
        at: input.now,
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        // `related_member_id`, never `member_id`: a deletion is not member activity.
        relatedMemberId: authorized.value.relatedMemberId,
      },
      [stamped],
      tx,
    );
    return ok({ released: true });
  });
}
