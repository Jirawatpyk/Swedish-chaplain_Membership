/**
 * F119 review finding F2-1 — stamp `deleted_at` on every live image of one
 * owner, and audit each stamped row, INSIDE the caller's transaction.
 *
 * WHY. `broadcast_images.owner_id` deliberately carries no FK (it points at a
 * broadcast OR a template), so nothing in the database removes an image row
 * when its owner row is hard-deleted. Two paths hard-delete an owner — the
 * member's "Discard draft" (`DELETE /api/broadcasts/draft/[id]`) and the daily
 * `pruneExpiredDrafts` — and before this helper existed neither touched the
 * image rows. The consequence was not a leaked row, it was leaked BYTES: the
 * sweep reads `deleted_at IS NOT NULL`, so a row left un-stamped is invisible
 * to it forever, and the member's photograph stays at a public, unauthenticated
 * blob URL with no path in the product that can ever remove it — including the
 * GDPR Art. 17 / PDPA §33 erasure cascade.
 *
 * This is a HELPER, not a use case: it takes the caller's `tx` rather than
 * opening its own, because the whole point is that the stamp and the owner's
 * deletion co-commit. A stamp that commits without the delete marks live
 * images for reaping; a delete that commits without the stamp is the bug above.
 *
 * The audit emit is RAW (`audit.emit`, not `safeAuditEmit`): this row is the
 * PDPA evidence that the reference was removed, so a failed emit must roll the
 * stamp back rather than leave an unevidenced deletion.
 *
 * `blob_deleted: false` in every payload here — the BYTES are not deleted at
 * this moment. They go on the next daily sweep, under the last-reference rule,
 * which emits its own `broadcast_image_removed { reason: 'sweep' }`.
 *
 * Pure Application — only ports.
 */
import type { TenantSlug } from '@/modules/tenants';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastImageOwnerKind, BroadcastImagesRepo, BroadcastImagesTx } from '../ports/broadcast-images-repo';

/**
 * Why the reference went away. Kept as a bounded literal set so the audit
 * trail can tell a member's own discard from a retention prune from an
 * erasure — three very different compliance stories.
 */
export type ImageRemovalReason = 'draft_discarded' | 'draft_pruned' | 'member_erased';

export interface MarkOwnerImagesRemovedDeps {
  readonly imagesRepo: Pick<BroadcastImagesRepo, 'markDeletedByOwner'>;
  readonly audit: AuditPort;
}

export interface MarkOwnerImagesRemovedInput {
  readonly tenantId: TenantSlug;
  readonly owner: { readonly kind: BroadcastImageOwnerKind; readonly id: string };
  readonly reason: ImageRemovalReason;
  readonly at: Date;
  readonly requestId: string;
  /** `'system'` for the cron and for the erasure cascade. */
  readonly actorUserId: string;
  /**
   * The session role, or `'system'`. NEVER a literal stand-in for an unknown
   * role — `pnpm check:actor-role-truth` guards that invariant.
   */
  readonly actorRole: string | null;
  /**
   * The member the E-Blast belongs to, or null for a template. This is
   * `related_member_id`, NOT snake_case `member_id`: a deletion is not member
   * activity, and `member_id` is the one key the 0009 `last_activity_at`
   * trigger reads.
   */
  readonly relatedMemberId: string | null;
}

export async function markOwnerImagesRemoved(
  deps: MarkOwnerImagesRemovedDeps,
  input: MarkOwnerImagesRemovedInput,
  tx: BroadcastImagesTx,
): Promise<number> {
  const stamped = await deps.imagesRepo.markDeletedByOwner(input.tenantId, input.owner, input.at, tx);
  await auditImagesRemoved(deps.audit, input, stamped, tx);
  return stamped.length;
}

/**
 * The audit half on its own, for a caller that did the stamping with a
 * different query — the erasure cascade stamps by MEMBER, not by owner, in one
 * UPDATE rather than one per broadcast. Shared so the two paths cannot drift
 * into two different payload shapes for the same event type.
 */
export async function auditImagesRemoved(
  audit: AuditPort,
  input: Omit<MarkOwnerImagesRemovedInput, 'owner'>,
  images: readonly { readonly id: string; readonly ownerKind: string; readonly ownerId: string; readonly contentHash: string }[],
  tx: BroadcastImagesTx,
): Promise<void> {
  for (const image of images) {
    await audit.emit(tx, {
      eventType: 'broadcast_image_removed',
      tenantId: input.tenantId,
      requestId: input.requestId,
      actorUserId: input.actorUserId,
      summary: `E-Blast image marked for deletion (${input.reason})`,
      payload: {
        related_member_id: input.relatedMemberId,
        owner_kind: image.ownerKind,
        owner_id: image.ownerId,
        image_id: image.id,
        content_hash: image.contentHash,
        // The row is marked here; the bytes go on the next daily sweep.
        blob_deleted: false,
        reason: input.reason,
        actor_role: input.actorRole,
      },
    });
  }
}
