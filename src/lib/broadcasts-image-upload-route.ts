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
 * Order of checks is the contract: gate (route) → `content-length` (413 over
 * the form cap, BEFORE the body is buffered) → multipart shape (400
 * `invalid_body`) → the owner id, read from that one parsed form → the actor's
 * write bucket, consumed ABOVE the ownership read, the blob write and the
 * ClamAV call (429 + `Retry-After`; a refused call scans nothing and stores
 * nothing) → `authorizeImageOwner` (404 + probe audit, never 403; 409 when the
 * E-Blast is closed to this actor) → `uploadInlineImage` (413 / 415 / 422 /
 * 503) → 201 `{ blobUrl, allowlistedHostname, contentHash, imageId }`.
 *
 * Time budget. All three routes pin `maxDuration = 60`, and the work inside
 * `uploadInlineImage` that can actually consume it is the ClamAV scan, the
 * EXIF-strip RE-ENCODE and the Blob PUT — the scan and the PUT run 5-10 s
 * between them at the 5 MB cap. ROUND-2 R-M4 gave the re-encode its own 15 s
 * wall-clock bound, because an unbounded libvips decode could otherwise spend
 * the whole 60 s and the member would get a platform timeout rather than a
 * 503 they can retry.
 *
 * Security review F1-3 (2026-09-22) — two resource bugs closed here:
 *
 *   - This module opened NO transaction of its own. It used to wrap the whole
 *     pipeline in `runInTenant(input.tenant, …)` whose `tx` nothing read,
 *     while `authorizeImageOwner`'s repos and `imagesRepo.withTx` each open
 *     their own. The outer scope therefore held one pool connection
 *     idle-in-transaction across the ClamAV scan (up to 50 s at the 5 MB cap)
 *     and the Blob PUT while the inner paths asked the pool — `max: 10` in
 *     `src/lib/db.ts` — for a second. Ten concurrent uploads starved the site.
 *   - The body is parsed ONCE. The member route used to read `draftId` from
 *     `await request.clone().formData()` before this handler's `content-length`
 *     guard ran, and the handler then parsed the form again; `readOwnerId`
 *     hands that read back here, after the 413 and off the single parse.
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
  authorizeImageOwner,
  broadcastsRateLimiter,
  makeAuthorizeImageOwnerDeps,
  makeUploadInlineImageDeps,
  uploadInlineImage,
  type BroadcastImageOwnerKind,
} from '@/modules/broadcasts';
import type { MemberId } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';

/** 10 % headroom over the use case's 5 MB cap — the form is refused before it is buffered. */
export const MAX_IMAGE_FORM_BYTES = 5.5 * 1024 * 1024;

export type ImageUploadRouteActor =
  | {
      readonly kind: 'member';
      readonly memberId: MemberId;
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

/**
 * Where the owner id comes from. The two admin routes carry it in the URL
 * (`id`); the member route carries it in the multipart body, so it supplies
 * `readOwnerId` and this module hands it the ONE parsed form — returning
 * `null` for a missing or malformed value, which is a 400 before any lookup.
 */
export type ImageUploadRouteOwner =
  | { readonly kind: BroadcastImageOwnerKind; readonly id: string }
  | {
      readonly kind: BroadcastImageOwnerKind;
      readonly readOwnerId: (form: FormData) => string | null;
      /** Field name for the 400 `fieldErrors` envelope (e.g. `draftId`). */
      readonly field: string;
    };

export interface ImageUploadRouteInput {
  readonly tenant: TenantContext;
  readonly owner: ImageUploadRouteOwner;
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

  // The owner id, from the URL or from this one parsed form (F1-3).
  let owner: { readonly kind: BroadcastImageOwnerKind; readonly id: string };
  if ('id' in input.owner) {
    owner = input.owner;
  } else {
    const ownerId = input.owner.readOwnerId(form);
    if (ownerId === null) {
      return errorResponse(400, 'invalid_body', correlationId, {
        fieldErrors: { [input.owner.field]: [`${input.owner.field} is required`] },
      });
    }
    owner = { kind: input.owner.kind, id: ownerId };
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
    // No `runInTenant` here (F1-3): `authorizeImageOwner`'s repos and
    // `imagesRepo.withTx` each open their own tenant-bound scope, and an outer
    // one only held a connection idle-in-transaction across the ClamAV scan
    // and the Blob PUT while they asked the `max: 10` pool for a second.
    const authorized = await authorizeImageOwner(makeAuthorizeImageOwnerDeps(input.tenant.slug), {
      tenantId: input.tenant.slug as never,
      owner,
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
      owner,
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
        // F2-6 — a 0-byte file is a 400 with the bilingual envelope (the
        // member can act on it), not a 413 and not the raw-kind shape the
        // pipeline rejects below use. The uploader reads both envelopes.
        case 'broadcast_image_empty':
          return errorResponse(400, 'broadcast_image_empty', correlationId, {
            fieldErrors: { file: ['broadcast_image_empty'] },
          });
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
  } catch (e) {
    logger.error(
      { err: errKind(e), correlationId, tenantId: input.tenant.slug, errorId: `M119.${input.surface}.image_upload` },
      'broadcasts.image_upload.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
