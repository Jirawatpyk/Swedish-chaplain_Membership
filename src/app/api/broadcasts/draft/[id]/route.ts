/**
 * T075 — DELETE `/api/broadcasts/draft/[id]`.
 *
 * Deletes a draft broadcast. No LIFECYCLE audit emission per FR-001 — drafts
 * are user-controlled scratch space; only `broadcast_drafted` (on create)
 * + `broadcast_submitted` / `broadcast_cancelled` (post-submit lifecycle)
 * generate lifecycle audit rows.
 *
 * It DOES emit one `broadcast_image_removed` per inline image the draft owns
 * (F119 review finding F2-1). That is not a lifecycle event, it is PDPA
 * evidence that a member's uploaded bytes stopped being referenced — the
 * discard is the only signal the sweep and the erasure cascade will ever get,
 * because `broadcast_images.owner_id` has no FK and this DELETE is a hard one.
 *
 * Authz: caller MUST be the originating member (`requested_by_member_id`).
 * Cross-member probe → 404 (FR-037).
 *
 * Status guard: only `status = 'draft'` rows are deletable. Submitted
 * + later-state rows MUST go through the cancel flow (US2/US3) — a
 * DELETE on a submitted broadcast returns 409 `broadcast_immutable_after_submit`.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import {
  parseBroadcastId,
  makeGetBroadcastDeps,
  makeMarkOwnerImagesRemovedDeps,
  markOwnerImagesRemoved,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import {
  errorResponse,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';

/**
 * ROUND-2 R-H1 — the DELETE matched no row, so the draft this request read a
 * moment ago is no longer a draft (a concurrent submit). Thrown INSIDE the
 * transaction so it rolls back and nothing downstream stamps anything;
 * caught below and mapped to the same 409 the pre-flight status guard returns.
 */
class DraftNoLongerDeletableError extends Error {
  constructor() {
    super('draft_no_longer_deletable');
    this.name = 'DraftNoLongerDeletableError';
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) {
    return ctx.response;
  }

  const { id } = await context.params;
  const parsed = parseBroadcastId(id);
  if (!parsed.ok) {
    return errorResponse(404, 'broadcast_not_found', correlationId);
  }
  const broadcastId = parsed.value;

  const deps = makeGetBroadcastDeps(ctx.tenant.slug);
  try {
    const broadcast = await deps.broadcastsRepo.findById(
      ctx.tenant.slug,
      broadcastId,
    );
    if (broadcast === null) {
      return errorResponse(404, 'broadcast_not_found', correlationId);
    }
    // Cross-member probe → 404 (own data only)
    if (broadcast.requestedByMemberId !== ctx.member.memberId) {
      logger.warn(
        {
          correlationId,
          tenantId: ctx.tenant.slug,
          memberId: ctx.member.memberId,
          broadcastOwnerMemberId: broadcast.requestedByMemberId,
          broadcastId: broadcastId as string,
        },
        'broadcasts.draft.cross_member_probe',
      );
      return errorResponse(404, 'broadcast_not_found', correlationId);
    }
    if (broadcast.status !== 'draft') {
      return errorResponse(
        409,
        'broadcast_immutable_after_submit',
        correlationId,
        {
          details: {
            broadcastId: broadcastId as string,
            currentStatus: broadcast.status,
          },
        },
      );
    }

    await runInTenant(ctx.tenant, async (tx) => {
      // ROUND-2 R-H1 (data loss) — `RETURNING`, because the status guard above
      // read `findById` OUTSIDE this transaction. A submit that lands in that
      // window makes `AND status = 'draft'` match 0 rows, and the old code went
      // on to stamp every image of the now-SUBMITTED broadcast anyway: the
      // sweep then deleted their blobs and an approved E-Blast shipped with 404
      // images. Nothing is stamped unless a row came back. Same shape
      // `pruneExpiredDrafts` already uses.
      const deleted = (await tx.execute(sql`
        DELETE FROM broadcasts
         WHERE tenant_id = ${ctx.tenant.slug}
           AND broadcast_id = ${broadcastId as string}
           AND status = 'draft'
        RETURNING broadcast_id
      `)) as unknown as ReadonlyArray<{ broadcast_id: string }>;
      if (deleted.length === 0) {
        throw new DraftNoLongerDeletableError();
      }
      // F119 review finding F2-1 (PDPA) — the draft's images go WITH it, in
      // this transaction. `broadcast_images.owner_id` carries no FK (two
      // possible parents), so this hard DELETE left the image rows live and
      // un-stamped; the daily sweep reads `deleted_at IS NOT NULL`, so those
      // rows were invisible to it FOREVER and the member's uploaded photo
      // stayed at a public, unauthenticated blob URL that no code path could
      // reach — not the sweep, not the Art. 17 / §33 erasure cascade.
      // Stamping here marks the reference gone; the bytes go on the next
      // sweep under the last-reference rule.
      await markOwnerImagesRemoved(
        makeMarkOwnerImagesRemovedDeps(ctx.tenant.slug),
        {
          tenantId: ctx.tenant.slug as never,
          owner: { kind: 'broadcast', id: broadcastId as string },
          reason: 'draft_discarded',
          at: new Date(),
          requestId: correlationId,
          actorUserId: ctx.current.user.id,
          // The session's role as held, never a literal stand-in
          // (`pnpm check:actor-role-truth`).
          actorRole: ctx.current.user.role ?? null,
          relatedMemberId: ctx.memberId,
        },
        tx,
      );
    });

    return new NextResponse(null, {
      status: 204,
      headers: baseHeaders(correlationId),
    });
  } catch (e) {
    if (e instanceof DraftNoLongerDeletableError) {
      // The transaction rolled back: the row is untouched and NO image of it
      // was stamped. Same answer the pre-flight guard gives, one race later.
      logger.warn(
        {
          correlationId,
          tenantId: ctx.tenant.slug,
          memberId: ctx.member.memberId,
          broadcastId: id,
        },
        'broadcasts.draft.delete.status_changed_mid_flight',
      );
      return errorResponse(409, 'broadcast_immutable_after_submit', correlationId, {
        details: { broadcastId: broadcastId as string },
      });
    }
    logger.error(
      {
        err: errKind(e),
        correlationId,
        tenantId: ctx.tenant.slug,
        memberId: ctx.member.memberId,
        broadcastId: id,
      },
      'broadcasts.draft.delete.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}

