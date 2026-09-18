/**
 * F119 T106 / T107 / T146 — the shared half of the three image-upload
 * endpoints:
 *   POST /api/broadcasts/inline-image-upload          (member — own draft)
 *   POST /api/admin/broadcasts/[id]/images            (staff — draft | submitted, T106a adds in_design)
 *   POST /api/admin/broadcasts/templates/[id]/images  (staff — a template)
 * Each route owns its gate, its kill-switch check and its actor; this
 * module owns the multipart contract, the write bucket, the ownership check
 * and the response envelope so the three cannot drift (FR-040: the same
 * size, type, virus-scan and source rules for every image).
 *
 * Order of checks is the contract: gate (route) → multipart shape (400
 * `invalid_body`; 413 over the form cap) → the actor's write bucket, consumed
 * ABOVE the ownership read, the blob write and the ClamAV call (429 +
 * `Retry-After`; a refused call scans nothing and stores nothing) →
 * `authorizeImageOwner` (404 + probe audit, never 403; 409 when the E-Blast
 * is closed to this actor) → `uploadInlineImage` (413 / 415 / 422 / 503) →
 * 201 `{ blobUrl, allowlistedHostname, contentHash, imageId }`.
 */
import { NextResponse } from 'next/server';
import { runInTenant } from '@/lib/db';
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
  authorizeImageOwner,
  broadcastsRateLimiter,
  makeAuthorizeImageOwnerDeps,
  makeUploadInlineImageDeps,
  uploadInlineImage,
  type BroadcastImageOwnerKind,
} from '@/modules/broadcasts';
import type { TenantContext } from '@/modules/tenants';

/** 10 % headroom over the use case's 5 MB cap — the form is refused before it is buffered. */
export const MAX_IMAGE_FORM_BYTES = 5.5 * 1024 * 1024;

export type ImageUploadRouteActor =
  | {
      readonly kind: 'member';
      readonly memberId: string;
      readonly userId: string;
      readonly email: string;
      readonly role: string | null;
    }
  | {
      readonly kind: 'staff';
      readonly userId: string;
      readonly email: string;
      readonly role: string | null;
    };

export interface ImageUploadRouteInput {
  readonly tenant: TenantContext;
  readonly owner: { readonly kind: BroadcastImageOwnerKind; readonly id: string };
  readonly actor: ImageUploadRouteActor;
  readonly surface: 'member' | 'staff' | 'template';
}

export async function handleImageUpload(
  request: Request,
  input: ImageUploadRouteInput,
  correlationId: string,
): Promise<NextResponse> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > MAX_IMAGE_FORM_BYTES) {
    return NextResponse.json({ error: 'broadcast_image_too_large' }, { status: 413, headers: baseHeaders(correlationId) });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return errorResponse(400, 'invalid_body', correlationId, { fieldErrors: { file: ['file is required'] } });
  }

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

  try {
    return await runInTenant(input.tenant, async () => {
      const authorized = await authorizeImageOwner(makeAuthorizeImageOwnerDeps(input.tenant.slug), {
        tenantId: input.tenant.slug as never,
        owner: input.owner,
        actor: input.actor.kind === 'member' ? { kind: 'member', memberId: input.actor.memberId } : { kind: 'staff' },
        actorUserId: input.actor.userId,
        requestId: correlationId,
      });
      if (!authorized.ok) {
        switch (authorized.error.kind) {
          case 'not_found':
            return errorResponse(404, 'broadcast_not_found', correlationId);
          case 'closed':
            return errorResponse(409, 'broadcast_invalid_state_transition', correlationId, {
              details: { status: authorized.error.status },
            });
          default:
            return assertNever(authorized.error);
        }
      }

      const bytes = Buffer.from(await file.arrayBuffer());
      const result = await uploadInlineImage(makeUploadInlineImageDeps(input.tenant.slug), {
        tenantId: input.tenant.slug as never,
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        owner: input.owner,
        actor:
          input.actor.kind === 'member'
            ? { role: 'member', memberId: input.actor.memberId }
            : { role: input.actor.role ?? null, relatedMemberId: authorized.value.relatedMemberId },
        requestId: correlationId,
        fileBytes: bytes,
        filename: file.name,
        mimeType: file.type,
      });
      if (!result.ok) {
        let status: number;
        switch (result.error.kind) {
          case 'broadcast_image_too_large':
            status = 413;
            break;
          case 'broadcast_image_invalid_mime':
            status = 415;
            break;
          case 'broadcast_image_unsafe':
            status = 422;
            break;
          case 'storage_unavailable':
            status = 503;
            break;
          default:
            return assertNever(result.error);
        }
        return NextResponse.json({ error: result.error.kind }, { status, headers: baseHeaders(correlationId) });
      }
      return NextResponse.json(
        {
          blobUrl: result.value.blobUrl,
          allowlistedHostname: result.value.allowlistedHostname,
          contentHash: result.value.contentHash,
          imageId: result.value.imageId,
        },
        { status: 201, headers: baseHeaders(correlationId) },
      );
    });
  } catch (e) {
    logger.error(
      { err: errKind(e), correlationId, tenantId: input.tenant.slug, errorId: `M119.${input.surface}.image_upload` },
      'broadcasts.image_upload.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
