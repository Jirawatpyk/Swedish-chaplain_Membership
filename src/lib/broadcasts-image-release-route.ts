/**
 * Spec 131 — the shared half of the three image RELEASE endpoints:
 *   DELETE /api/broadcasts/inline-image-upload/[imageId]?draftId=…  (member — own draft)
 *   DELETE /api/admin/broadcasts/[id]/images/[imageId]               (staff — draft | submitted | in_design)
 *   DELETE /api/admin/broadcasts/templates/[id]/images/[imageId]     (staff — a template)
 *
 * The mirror of `broadcasts-image-upload-route.ts`: each route owns its gate,
 * its kill-switch, its id parsing and its actor; this module owns the write
 * bucket, the use case call and the response envelope, so a release is
 * refused exactly where an upload is.
 *
 * Order of checks: gate (route) → ids (route; 404 / 400 before any lookup)
 * → the actor's write bucket (429 + `Retry-After`, nothing read) →
 * `releaseUnusedImage` (`authorizeImageOwner`: 404 + probe audit, 409 when the
 * owner is closed to this actor) → 200 `{ released }`.
 *
 * CSRF and the READ_ONLY_MODE freeze are `src/proxy.ts`'s, for every
 * state-changing `/api/**` request.
 */
import { NextResponse } from 'next/server';
import { assertNever } from '@/lib/assert-never';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import {
  MEMBER_WRITE_RATE_MAX,
  MEMBER_WRITE_RATE_WINDOW_SECONDS,
  STAFF_WRITE_RATE_MAX,
  STAFF_WRITE_RATE_WINDOW_SECONDS,
  memberWriteRateKey,
  staffWriteRateKey,
} from '@/lib/broadcasts-write-rate-limit';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import {
  broadcastsRateLimiter,
  makeReleaseUnusedImageDeps,
  releaseUnusedImage,
  type BroadcastImageOwnerKind,
} from '@/modules/broadcasts';
import type { MemberId } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';

export type ImageReleaseRouteActor =
  | {
      readonly kind: 'member';
      readonly memberId: MemberId;
      readonly userId: string;
      readonly role: string | null;
    }
  | {
      readonly kind: 'staff';
      readonly userId: string;
      readonly role: string | null;
    };

export interface ImageReleaseRouteInput {
  readonly tenant: TenantContext;
  readonly owner: { readonly kind: BroadcastImageOwnerKind; readonly id: string };
  readonly imageId: string;
  readonly actor: ImageReleaseRouteActor;
  readonly surface: 'member' | 'staff' | 'template';
}

export async function handleImageRelease(
  input: ImageReleaseRouteInput,
  correlationId: string,
): Promise<NextResponse> {
  // #658 reliability L4 — the rate limiter is inside the try, so an Upstash
  // fault answers the 500 envelope with its correlation id, not a bare crash.
  try {
    const limit =
      input.actor.kind === 'member'
        ? await broadcastsRateLimiter.checkLimit(
            memberWriteRateKey(input.tenant.slug, input.actor.userId),
            MEMBER_WRITE_RATE_MAX,
            MEMBER_WRITE_RATE_WINDOW_SECONDS,
          )
        : await broadcastsRateLimiter.checkLimit(
            staffWriteRateKey(input.tenant.slug, input.actor.userId),
            STAFF_WRITE_RATE_MAX,
            STAFF_WRITE_RATE_WINDOW_SECONDS,
          );
    if (!limit.ok) {
      return errorResponse(429, 'broadcast_rate_limit_exceeded', correlationId, {
        retryAfterSeconds: limit.error.retryAfterSeconds,
        details: { retryAfterSeconds: limit.error.retryAfterSeconds },
      });
    }

    const result = await releaseUnusedImage(makeReleaseUnusedImageDeps(input.tenant.slug), {
      tenantId: input.tenant.slug as never,
      owner: input.owner,
      imageId: input.imageId,
      actor: input.actor.kind === 'member' ? { kind: 'member', memberId: input.actor.memberId } : { kind: 'staff' },
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      requestId: correlationId,
      now: new Date(),
    });
    if (!result.ok) {
      switch (result.error.kind) {
        case 'not_found':
          return errorResponse(404, 'broadcast_not_found', correlationId);
        case 'closed':
          // The same codes the upload route answers for the same refusal.
          return errorResponse(
            409,
            input.surface === 'member' ? 'broadcast_invalid_state_transition' : 'stage_changed',
            correlationId,
            { details: { status: result.error.status } },
          );
        default:
          return assertNever(result.error);
      }
    }
    return NextResponse.json({ released: result.value.released }, { status: 200, headers: baseHeaders(correlationId) });
  } catch (e) {
    logger.error(
      { err: errKind(e), correlationId, tenantId: input.tenant.slug, errorId: `M131.${input.surface}.image_release` },
      'broadcasts.image_release.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
